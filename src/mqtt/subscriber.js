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

// Map tracking consecutive 0°C readings per device
const deviceZeroCounts = new Map();

function parseIndianTimestamp(payload) {
  // Prioritize string timestamp fields (e.g. "2026-07-25T12:33:25")
  let dateVal = payload.timestamp || payload.ts || payload.datetime || payload.created_at || payload.time_stamp || payload.device_time;
  
  if (!dateVal && payload.date) {
    dateVal = payload.time ? `${payload.date} ${payload.time}` : payload.date;
  }

  if (dateVal && typeof dateVal === "string") {
    let str = dateVal.trim();

    if (/^\d+$/.test(str)) {
      const epochNum = Number(str);
      return new Date(epochNum > 1e11 ? epochNum : epochNum * 1000);
    }

    // ISO string with timezone offset or 'Z' (e.g. "2026-07-25T12:33:25+05:30" or "2026-07-25T07:03:25Z")
    if (/[Z+-]\d{2}:?\d{2}$/.test(str) || str.endsWith("Z")) {
      const parsed = new Date(str);
      if (!isNaN(parsed.getTime())) return parsed;
    }

    // ISO/SQL string without timezone offset e.g. "2026-07-25T12:33:25" or "2026-07-25 12:33:25"
    // The device sends local Indian Time (IST, +05:30)
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) {
      const parsed = new Date(str.replace(' ', 'T') + '+05:30');
      if (!isNaN(parsed.getTime())) return parsed;
    }

    // Format: DD/MM/YYYY HH:mm:ss or DD-MM-YYYY HH:mm:ss
    if (/^(\d{2})[-/](\d{2})[-/](\d{4})[ T](\d{2}:\d{2}:\d{2})$/.test(str)) {
      const m = str.match(/^(\d{2})[-/](\d{2})[-/](\d{4})[ T](\d{2}:\d{2}:\d{2})$/);
      const parsed = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}+05:30`);
      if (!isNaN(parsed.getTime())) return parsed;
    }

    // Format: YYYY/MM/DD HH:mm:ss
    if (/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}:\d{2}:\d{2})$/.test(str)) {
      const m = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
      const parsed = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}+05:30`);
      if (!isNaN(parsed.getTime())) return parsed;
    }

    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  if (typeof dateVal === "number" && Number.isFinite(dateVal)) {
    return new Date(dateVal > 1e11 ? dateVal : dateVal * 1000);
  }

  if (payload.epoch) {
    const epochNum = Number(payload.epoch);
    if (Number.isFinite(epochNum)) {
      return new Date(epochNum > 1e11 ? epochNum : epochNum * 1000);
    }
  }

  return new Date();
}

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

      // Parse timestamp from device payload (supporting IST local time, ISO, Epoch, etc.)
      const ts = parseIndianTimestamp(payload);

      // Parse GPS & Telemetry fields (support top-level properties and nested `gps` object)
      const gps = payload.gps || {};
      const latitude = payload.latitude !== undefined ? payload.latitude : (gps.latitude !== undefined ? gps.latitude : null);
      const longitude = payload.longitude !== undefined ? payload.longitude : (gps.longitude !== undefined ? gps.longitude : null);
      const speed_knots = payload.speed_knots ?? payload.speed ?? gps.speed_knots ?? gps.speed ?? 0.0;
      const course_deg = payload.course_deg ?? payload.course ?? gps.course_deg ?? gps.course ?? 0.0;
      const satellites = payload.satellites ?? gps.satellites ?? null;
      const isValid = payload.valid !== undefined ? Boolean(payload.valid) : (gps.valid !== undefined ? Boolean(gps.valid) : true);
      const tempRaw = payload.temperature_c !== undefined ? Number(payload.temperature_c) : (payload.temp !== undefined ? Number(payload.temp) : null);
      const tempParsed = tempRaw !== null && !isNaN(tempRaw) ? Number(tempRaw.toFixed(2)) : null;
      const faultCode = payload.fault_code !== undefined ? Number(payload.fault_code) : 0;

      // Filter out only 0°C readings as invalid sensor zero values (allowing all other temperatures including <= -200°C)
      const isZeroTemp = tempParsed === null || Math.abs(tempParsed) < 0.0001;
      const validTemp = isZeroTemp ? null : tempParsed;

      if (isZeroTemp && tempRaw !== null) {
        const currentZeroCount = (deviceZeroCounts.get(device.id) || 0) + 1;
        deviceZeroCounts.set(device.id, currentZeroCount);
        console.warn(`[MQTT] Device ${device.device_id}: Received temperature 0°C (repeat count: ${currentZeroCount}). Ignoring 0 reading and NOT storing to database.`);
      } else if (!isZeroTemp) {
        deviceZeroCounts.set(device.id, 0);
      }

      // 1. Insert Telemetry to InfluxDB (Only write when non-zero temperature is present)
      if (validTemp !== null) {
        try {
          const point = new Point('telemetry')
            .tag('device_id', device.device_id)
            .floatField('temperature', Number(validTemp))
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
      }

      // 2. Upsert DeviceStatus (Preserve previous valid temperature_c if incoming is 0)
      const [status, created] = await DeviceStatus.findOrCreate({
        where: { device_id: device.id },
        defaults: {
          customer_id: device.customer_id,
          temperature_c: validTemp,
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
          temperature_c: validTemp !== null ? validTemp : status.temperature_c,
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
            value: validTemp !== null ? validTemp : tempRaw
          });
        }

        if (tempParsed !== null && Number.isFinite(tempParsed) && !isZeroTemp) {
          if (tempParsed <= -200) {
            // Temperature <= -200°C indicates thermocouple disconnect / open circuit (e.g., -242.02°C)
            alarmsToUpsert.push({
              type: "thermocouple_open",
              severity: "critical",
              msg: `Thermocouple open circuit / fault reading (${tempParsed}°C)`,
              value: tempParsed
            });
          } else {
            if (tempParsed > Number(device.high_threshold)) {
              alarmsToUpsert.push({
                type: "high_temp",
                severity: "critical",
                msg: `Temperature ${tempParsed}°C > ${device.high_threshold}°C limit`,
                value: tempParsed
              });
            }
            if (tempParsed < Number(device.low_threshold)) {
              alarmsToUpsert.push({
                type: "low_temp",
                severity: "critical",
                msg: `Temperature ${tempParsed}°C < ${device.low_threshold}°C limit`,
                value: tempParsed
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
