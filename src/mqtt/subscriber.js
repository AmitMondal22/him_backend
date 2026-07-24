import mqtt from "mqtt";
import dotenv from "dotenv";
import { Op } from "sequelize";
import { Device, DeviceStatus, Alarm } from "../models/index.js";
import { Point } from "@influxdata/influxdb-client";
import { writeApi } from "../config/influx.js";
import { broadcastRealtimeEvent } from "../../server.js";

dotenv.config();

const MQTT_URL = process.env.MQTT_BROKER_URL || "mqtt://mqttfps.iotblitz.in:1883";
const TOPICS = [
  "/Himardri/data/+",
  "Himardri/data/+",
  "/Himardri/data/#",
  "Himardri/data/#"
];

export const initMqttSubscriber = () => {
  const options = {};
  const username = process.env.MQTT_USER || "ibfps";
  const password = process.env.MQTT_PASS || "ib8520";
  if (username) options.username = username;
  if (password) options.password = password;

  console.log(`[MQTT] Connecting to broker at ${MQTT_URL}...`);
  const client = mqtt.connect(MQTT_URL, options);

  client.on("connect", () => {
    console.log(`[MQTT] Connected. Subscribing to topics: ${TOPICS.join(", ")}`);
    TOPICS.forEach((topicPattern) => {
      client.subscribe(topicPattern, (err) => {
        if (err) {
          console.error(`[MQTT] Subscription failed for ${topicPattern}:`, err);
        }
      });
    });
  });

  client.on("message", async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      console.log(`[MQTT] Received packet on topic [${topic}]:\n${JSON.stringify(payload, null, 2)}\n`);

      // Extract device code from topic path or payload
      const topicClean = topic.startsWith("/") ? topic.slice(1) : topic;
      const parts = topicClean.split("/");
      const topicDeviceCode = parts.length > 2 && parts[2] !== "data" ? parts[2] : (parts.length > 1 && parts[1] !== "data" ? parts[1] : null);

      const deviceCode = payload.device_id || payload.deviceCode || payload.device_code || topicDeviceCode;

      if (!deviceCode && !payload.imei) {
        console.warn(`[MQTT] Telemetry ignored: No device identifier in topic (${topic}) or payload`);
        return;
      }

      // Find device in DB by device_id or imei
      const searchConditions = [];
      if (deviceCode) searchConditions.push({ device_id: deviceCode });
      if (payload.device_id && payload.device_id !== deviceCode) searchConditions.push({ device_id: payload.device_id });
      if (payload.imei) searchConditions.push({ imei: String(payload.imei) });

      let device = await Device.findOne({
        where: { [Op.or]: searchConditions }
      });

      // Auto-register device if unknown
      if (!device && (deviceCode || payload.device_id)) {
        const newDeviceId = deviceCode || payload.device_id;
        console.log(`[MQTT] Auto-registering new device: ${newDeviceId}`);
        try {
          device = await Device.create({
            device_id: newDeviceId,
            imei: payload.imei ? String(payload.imei) : null,
            name: `Device ${newDeviceId}`,
            active: true,
            alarm_enabled: true
          });
        } catch (dbErr) {
          console.error(`[MQTT] Failed to auto-register device ${newDeviceId}:`, dbErr);
        }
      }

      if (!device) {
        console.warn(`[MQTT] Telemetry ignored: Could not find or register device for identifier ${deviceCode || payload.imei}`);
        return;
      }

      // Parse timestamp (epoch seconds/ms or ISO timestamp string)
      let ts = new Date();
      if (payload.epoch) {
        const epochNum = Number(payload.epoch);
        if (Number.isFinite(epochNum)) {
          ts = new Date(epochNum > 1e11 ? epochNum : epochNum * 1000);
        }
      } else if (payload.timestamp) {
        const parsed = new Date(payload.timestamp);
        if (!isNaN(parsed.getTime())) {
          ts = parsed;
        }
      }

      // Parse GPS & Telemetry fields (support top-level properties and nested `gps` object)
      const gps = payload.gps || {};
      const latitude = payload.latitude !== undefined ? payload.latitude : (gps.latitude !== undefined ? gps.latitude : null);
      const longitude = payload.longitude !== undefined ? payload.longitude : (gps.longitude !== undefined ? gps.longitude : null);
      const speed_knots = payload.speed_knots ?? payload.speed ?? gps.speed_knots ?? gps.speed ?? 0.0;
      const course_deg = payload.course_deg ?? payload.course ?? gps.course_deg ?? gps.course ?? 0.0;
      const satellites = payload.satellites ?? gps.satellites ?? null;
      const isValid = payload.valid !== undefined ? Boolean(payload.valid) : (gps.valid !== undefined ? Boolean(gps.valid) : true);
      const temp = payload.temperature_c !== undefined ? Number(payload.temperature_c) : (payload.temp !== undefined ? Number(payload.temp) : null);
      const faultCode = payload.fault_code !== undefined ? Number(payload.fault_code) : 0;

      // 1. Insert Telemetry to InfluxDB
      try {
        const point = new Point('telemetry')
          .tag('device_id', device.device_id)
          .floatField('temperature', temp !== null ? Number(temp) : 0.0)
          .floatField('latitude', latitude !== null ? Number(latitude) : 0.0)
          .floatField('longitude', longitude !== null ? Number(longitude) : 0.0)
          .floatField('speed', Number(speed_knots || 0.0))
          .floatField('course', Number(course_deg || 0.0))
          .booleanField('valid', isValid)
          .timestamp(ts);

        writeApi.writePoint(point);
        await writeApi.flush();
      } catch (err) {
        console.error("[InfluxDB] Failed to write telemetry point:", err);
      }

      // 2. Upsert DeviceStatus
      const [status, created] = await DeviceStatus.findOrCreate({
        where: { device_id: device.id },
        defaults: {
          customer_id: device.customer_id,
          temperature_c: temp,
          latitude: latitude,
          longitude: longitude,
          speed_knots: speed_knots,
          course_deg: course_deg,
          gps_valid: isValid,
          satellites: satellites,
          firmware_version: payload.firmware_version || "2.0.5",
          config_version: payload.config_version || "1.0.0",
          connection_state: "online",
          last_seen_at: ts,
        }
      });

      if (!created) {
        await status.update({
          temperature_c: temp !== null ? temp : status.temperature_c,
          latitude: latitude !== null ? latitude : status.latitude,
          longitude: longitude !== null ? longitude : status.longitude,
          speed_knots: speed_knots,
          course_deg: course_deg,
          gps_valid: isValid,
          satellites: satellites !== null ? satellites : status.satellites,
          connection_state: "online",
          last_seen_at: ts,
        });
      }

      // Broadcast single-device update to connected live clients
      try {
        const fullStatus = status.toJSON ? status.toJSON() : status;
        broadcastRealtimeEvent("device_status_update", {
          ...fullStatus,
          device_id: device.device_id, // ensure string device_id format
          devices: {
            device_id: device.device_id,
            name: device.name,
          }
        });
      } catch (bcErr) {
        console.error("[MQTT] Realtime broadcast error:", bcErr);
      }

      // 3. Alarm Threshold Verification
      if (device.alarm_enabled) {
        const alarmsToUpsert = [];

        if (faultCode > 0) {
          alarmsToUpsert.push({
            type: "sensor_fault",
            severity: "high",
            msg: `Sensor fault detected (fault code ${faultCode})`,
            value: temp
          });
        }

        if (temp !== null && Number.isFinite(temp)) {
          if (temp <= -200) {
            // Temperature <= -200°C indicates thermocouple disconnect / open circuit (e.g., -242.02°C)
            alarmsToUpsert.push({
              type: "thermocouple_open",
              severity: "critical",
              msg: `Thermocouple open circuit / fault reading (${temp}°C)`,
              value: temp
            });
          } else {
            if (temp > Number(device.high_threshold)) {
              alarmsToUpsert.push({
                type: "high_temp",
                severity: "critical",
                msg: `Temperature ${temp}°C > ${device.high_threshold}°C limit`,
                value: temp
              });
            }
            if (temp < Number(device.low_threshold)) {
              alarmsToUpsert.push({
                type: "low_temp",
                severity: "critical",
                msg: `Temperature ${temp}°C < ${device.low_threshold}°C limit`,
                value: temp
              });
            }
          }
        }

        for (const item of alarmsToUpsert) {
          const existing = await Alarm.findOne({
            where: {
              device_id: device.id,
              alarm_type: item.type,
              active: true
            }
          });

          if (existing) {
            await existing.update({
              last_occurred_at: ts,
              occurrences: existing.occurrences + 1,
              value: item.value,
            });
          } else {
            await Alarm.create({
              device_id: device.id,
              customer_id: device.customer_id,
              alarm_type: item.type,
              severity: item.severity,
              active: true,
              first_occurred_at: ts,
              last_occurred_at: ts,
              occurrences: 1,
              value: item.value,
              message: item.msg,
            });
          }
        }
      }
    } catch (err) {
      console.error("[MQTT] Error processing telemetry:", err);
    }
  });

  client.on("error", (err) => {
    console.error("[MQTT] Connection error:", err);
  });
};
