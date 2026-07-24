import { InfluxDB } from "@influxdata/influxdb-client";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.INFLUX_URL || "http://localhost:8086";
const token = process.env.INFLUX_TOKEN || "techavo-secret-admin-token-2026-xyz";
const org = process.env.INFLUX_ORG || "techavo";
const bucket = process.env.INFLUX_BUCKET || "telemetry";

console.log(`[InfluxDB] Initializing client pointing to ${url}...`);
const client = new InfluxDB({ url, token });

export const writeApi = client.getWriteApi(org, bucket, 'ns'); // ns = nanoseconds resolution
export const queryApi = client.getQueryApi(org);

export { org, bucket };
