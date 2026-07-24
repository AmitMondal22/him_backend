import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { sequelize } from "./src/config/database.js";
import { seedDatabaseProgrammatically, ensureInfluxData } from "./src/utils/seeder.js";
import apiRoutes from "./src/routes/api.js";
import { initMqttSubscriber } from "./src/mqtt/subscriber.js";
import { formatDatesInObject } from "./src/utils/timezone.js";

dotenv.config();

const fastify = Fastify({
  logger: true,
});

fastify.addHook("preSerialization", async (request, reply, payload) => {
  return formatDatesInObject(payload);
});

const PORT = process.env.PORT || 5000;

// Register Plugins
await fastify.register(cors, {
  origin: "*",
  credentials: true,
});

// SSE Real-time client registry
const sseClients = new Set();

export function broadcastRealtimeEvent(eventType, payload) {
  const data = JSON.stringify({ type: eventType, payload, timestamp: new Date().toISOString() });
  const msg = `data: ${data}\n\n`;
  for (const client of sseClients) {
    try {
      client.raw.write(msg);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Register API Routes
await fastify.register(apiRoutes, { prefix: "/api" });

// SSE Endpoint for Live Real-Time Telemetry and Status Updates
fastify.get("/api/realtime", (request, reply) => {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("Access-Control-Allow-Origin", "*");
  reply.raw.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  sseClients.add(reply);

  request.raw.on("close", () => {
    sseClients.delete(reply);
  });
});

// Health Check
fastify.get("/health", async (request, reply) => {
  return { status: "healthy", timestamp: new Date() };
});

// Sync DB and Start Server
async function startServer() {
  try {
    console.log("[DB] Connecting to PostgreSQL database...");
    await sequelize.authenticate();
    console.log("[DB] Connection established.");

    console.log("[DB] Syncing database models...");
    await sequelize.sync({ alter: true });
    console.log("[DB] Database models synced.");

    // Programmatically seed dummy database if empty
    await seedDatabaseProgrammatically();
    await ensureInfluxData();

    // Boot MQTT Telemetry subscriber
    initMqttSubscriber();

    // Start Listening
    await fastify.listen({ port: parseInt(PORT), host: "0.0.0.0" });
    console.log(`[Server] Fastify server running on port ${PORT}`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

startServer();
