import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { User } from "../models/index.js";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "techavo-secret-jwt-key-2026-xyz";

export const requireAuth = async (request, reply) => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.status(401).send({ error: "Unauthorized: Missing or invalid token" });
      return;
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User.findByPk(decoded.userId);
    if (!user) {
      reply.status(401).send({ error: "Unauthorized: User not found" });
      return;
    }

    request.user = user;
  } catch (error) {
    console.error("JWT Auth Middleware Error:", error);
    reply.status(401).send({ error: "Unauthorized: Invalid token" });
  }
};
