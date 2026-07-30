import mqtt from "mqtt";
import dotenv from "dotenv";
import { Op } from "sequelize";
import { Device, DeviceStatus, Alarm, NotificationRule } from "../models/index.js";
import { Point } from "@influxdata/influxdb-client";
import { writeApi } from "../config/influx.js";
import { broadcastRealtimeEvent } from "../../server.js";
import { sendAlarmEmail } from "../services/emailService.js";

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

      // Filter out 0°C readings: 1-4 times ignored without DB store, 5+ times marked as OPEN sensor
      const isZeroTemp = tempParsed === null || Math.abs(tempParsed) < 0.0001;
      const validTemp = isZeroTemp ? null : tempParsed;

      let currentZeroCount = 0;
      if (isZeroTemp && tempRaw !== null) {
        currentZeroCount = (deviceZeroCounts.get(device.id) || 0) + 1;
        deviceZeroCounts.set(device.id, currentZeroCount);
        console.warn(`[MQTT] Device ${device.device_id}: Received temperature 0°C (repeat count: ${currentZeroCount}).`);
      } else if (!isZeroTemp) {
        deviceZeroCounts.set(device.id, 0);
        try {
          await Alarm.update(
            { active: false },
            { where: { device_id: device.id, alarm_type: "thermocouple_open", active: true } }
          );
        } catch (alarmErr) {
          console.error("[MQTT] Error resolving thermocouple_open alarm:", alarmErr);
        }
      }

      const isSensorOpen = currentZeroCount >= 5;

      // 1. Insert Telemetry to InfluxDB (Only write when valid non-zero temperature is present)
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

      // 2. Upsert DeviceStatus
      // If 5+ zeroes received: clear temperature_c (set to null) so status indicates OPEN
      const initialTempC = validTemp !== null ? validTemp : (isSensorOpen ? null : undefined);

      const [status, created] = await DeviceStatus.findOrCreate({
        where: { device_id: device.id },
        defaults: {
          customer_id: device.customer_id,
          temperature_c: initialTempC,
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
        const nextTempC = validTemp !== null ? validTemp : (isSensorOpen ? null : status.temperature_c);
        await status.update({
          temperature_c: nextTempC,
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
          is_sensor_open: isSensorOpen,
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

        if (isSensorOpen) {
          alarmsToUpsert.push({
            type: "thermocouple_open",
            severity: "critical",
            msg: `Thermocouple OPEN / Disconnected (Received 0°C reading ${currentZeroCount} consecutive times)`,
            value: 0
          });
        } else if (tempParsed !== null && Number.isFinite(tempParsed) && !isZeroTemp) {
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

        // 4. Email Notifications — check matching rules and send if cooldown allows
        if (alarmsToUpsert.length > 0) {
          try {
            const rules = await NotificationRule.findAll({ where: { active: true } });
            for (const rule of rules) {
              // Check device match
              const ruleDeviceIds = Array.isArray(rule.device_ids) ? rule.device_ids : [];
              if (ruleDeviceIds.length > 0 && !ruleDeviceIds.includes(device.id)) continue;

              // Check alarm type match
              const ruleAlarmTypes = Array.isArray(rule.alarm_types) ? rule.alarm_types : [];
              const matchedAlarm = alarmsToUpsert.find(a => ruleAlarmTypes.length === 0 || ruleAlarmTypes.includes(a.type));
              if (!matchedAlarm) continue;

              // Check severity match
              const sevOrder = ["info", "low", "medium", "high", "critical"];
              const minSevIdx = sevOrder.indexOf(rule.min_severity || "medium");
              const alarmSevIdx = sevOrder.indexOf(matchedAlarm.severity || "medium");
              if (alarmSevIdx < minSevIdx) continue;

              // Check cooldown
              const cooldownMs = (rule.cooldown_minutes || 30) * 60 * 1000;
              if (rule.last_email_sent_at) {
                const lastSent = new Date(rule.last_email_sent_at).getTime();
                if (Date.now() - lastSent < cooldownMs) continue;
              }

              // Parse emails
              const emails = (rule.emails || "").split(/[,;\s]+/).map(e => e.trim()).filter(e => e && e.includes("@"));
              if (emails.length === 0) continue;

              // Send email
              const sent = await sendAlarmEmail(
                emails,
                device.device_id || device.name,
                matchedAlarm.type,
                matchedAlarm.msg,
                matchedAlarm.value,
                matchedAlarm.severity
              );

              if (sent) {
                await rule.update({ last_email_sent_at: new Date() });
              }
            }
          } catch (emailErr) {
            console.error("[MQTT] Email notification error:", emailErr);
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
