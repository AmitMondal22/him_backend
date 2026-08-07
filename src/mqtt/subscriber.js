import mqtt from "mqtt";
import dotenv from "dotenv";
import { Op } from "sequelize";
import { sequelize } from "../config/database.js";
import { Device, DeviceStatus, Alarm, NotificationRule, Asset } from "../models/index.js";
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
  "Himardri/data/#",
  "/Himadri/data/+",
  "Himadri/data/+",
  "/Himadri/data/#"
];

// Map tracking consecutive 0°C readings per device
const deviceZeroCounts = new Map();

function parseIndianTimestamp(payload) {
  // Prioritize string timestamp fields (e.g. "2026-07-25T12:33:25")
  let dateVal = payload.timestamp || payload.ts || payload.datetime || payload.created_at || payload.time_stamp || payload.device_time || payload.time;
  
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
      let payload = {};
      try {
        payload = JSON.parse(message.toString());
      } catch (parseErr) {
        console.warn(`[MQTT] Non-JSON payload received on topic [${topic}]: ${message.toString()}`);
        payload = { raw_message: message.toString() };
      }
      console.log(`[MQTT] Received packet on topic [${topic}]:\n${JSON.stringify(payload, null, 2)}\n`);

      // Extract device code from topic path or payload
      const topicClean = topic.startsWith("/") ? topic.slice(1) : topic;
      const parts = topicClean.split("/").filter(Boolean);
      
      // Find candidate device code from topic parts (filtering out common path words)
      let topicDeviceCode = null;
      const reservedWords = new Set(["himardri", "himadri", "data", "telemetry", "raw", "device", "devices", "status", "info", "gps"]);
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i].trim();
        if (part && !reservedWords.has(part.toLowerCase())) {
          topicDeviceCode = part;
          break;
        }
      }

      const rawDeviceId = 
        payload.device_id || 
        payload.deviceId || 
        payload.deviceCode || 
        payload.device_code || 
        payload.dev_id || 
        payload.devId || 
        payload.id || 
        payload.serial ||
        payload.serial_number ||
        topicDeviceCode;

      const deviceCode = rawDeviceId ? String(rawDeviceId).trim() : null;

      if (!deviceCode && !payload.imei) {
        console.warn(`[MQTT] Telemetry ignored: No device identifier in topic (${topic}) or payload`);
        return;
      }

      // Find device in DB by device_id (case-insensitive) or imei
      let device = null;
      const searchConditions = [];
      if (deviceCode) {
        searchConditions.push({ device_id: deviceCode });
        searchConditions.push(sequelize.where(sequelize.fn('LOWER', sequelize.col('device_id')), deviceCode.toLowerCase()));
      }
      if (payload.device_id && payload.device_id !== deviceCode) {
        searchConditions.push({ device_id: payload.device_id });
        searchConditions.push(sequelize.where(sequelize.fn('LOWER', sequelize.col('device_id')), String(payload.device_id).toLowerCase()));
      }
      if (payload.imei) {
        searchConditions.push({ imei: String(payload.imei) });
      }

      device = await Device.findOne({
        where: { [Op.or]: searchConditions },
        include: [{ model: Asset, attributes: ["name", "vehicle_number"] }]
      });

      // Auto-register device if unknown
      if (!device && (deviceCode || payload.device_id)) {
        const newDeviceId = String(deviceCode || payload.device_id).trim();
        console.log(`[MQTT] Auto-registering unique device: ${newDeviceId}`);
        try {
          device = await Device.create({
            device_id: newDeviceId,
            imei: payload.imei ? String(payload.imei).trim() : null,
            name: `Device ${newDeviceId}`,
            active: true,
            alarm_enabled: true,
            low_threshold: 2.0,
            high_threshold: 8.0
          });
        } catch (dbErr) {
          console.warn(`[MQTT] Device unique conflict for '${newDeviceId}', fetching existing record:`, dbErr.message);
          device = await Device.findOne({
            where: sequelize.where(sequelize.fn('LOWER', sequelize.col('device_id')), newDeviceId.toLowerCase())
          });
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
      const latitude = payload.latitude ?? payload.lat ?? payload.Latitude ?? gps.latitude ?? gps.lat ?? null;
      const longitude = payload.longitude ?? payload.lng ?? payload.lon ?? payload.Longitude ?? gps.longitude ?? gps.lng ?? gps.lon ?? null;
      const speed_knots = payload.speed_knots ?? payload.speed ?? payload.speed_kmh ?? gps.speed_knots ?? gps.speed ?? 0.0;
      const course_deg = payload.course_deg ?? payload.course ?? payload.heading ?? gps.course_deg ?? gps.course ?? gps.heading ?? 0.0;
      const satellites = payload.satellites ?? payload.sats ?? gps.satellites ?? gps.sats ?? null;
      const isValid = payload.valid !== undefined ? Boolean(payload.valid) : (gps.valid !== undefined ? Boolean(gps.valid) : true);

      // Extract temperature supporting multiple key names (temperature_c, temperature, temp, temp_c, temp1, t1, val, deg_c, celsius)
      const tempKeys = ['temperature_c', 'temperature', 'temp', 'temp_c', 'temp1', 't1', 'val', 'value', 'deg_c', 'celsius'];
      let tempRaw = null;
      for (const key of tempKeys) {
        if (payload[key] !== undefined && payload[key] !== null) {
          const num = Number(payload[key]);
          if (!isNaN(num)) {
            tempRaw = num;
            break;
          }
        }
      }
      if (tempRaw === null && payload.gps) {
        for (const key of tempKeys) {
          if (payload.gps[key] !== undefined && payload.gps[key] !== null) {
            const num = Number(payload.gps[key]);
            if (!isNaN(num)) {
              tempRaw = num;
              break;
            }
          }
        }
      }

      const tempParsed = tempRaw !== null && !isNaN(tempRaw) ? Number(tempRaw.toFixed(2)) : null;
      const faultCode = payload.fault_code !== undefined ? Number(payload.fault_code) : 0;

      // Detect 0°C thermocouple disconnection
      const isZeroTemp = tempParsed !== null && Math.abs(tempParsed) < 0.0001;
      const validTemp = isZeroTemp ? null : tempParsed;

      let currentZeroCount = 0;
      if (isZeroTemp && tempRaw !== null) {
        currentZeroCount = (deviceZeroCounts.get(device.id) || 0) + 1;
        deviceZeroCounts.set(device.id, currentZeroCount);
        console.warn(`[MQTT] Device ${device.device_id}: Received temperature 0°C (repeat count: ${currentZeroCount}).`);
      } else if (!isZeroTemp && tempRaw !== null) {
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

      // Extract backup record & signal details
      const isBackupRecord = payload.backup_record === true || String(payload.backup_record).toLowerCase() === "true";
      const backupSequence = payload.backup_sequence !== undefined && payload.backup_sequence !== null ? Number(payload.backup_sequence) : null;
      const csqVal = payload.csq !== undefined && payload.csq !== null ? Number(payload.csq) : null;
      const isRoaming = payload.roaming === true || String(payload.roaming).toLowerCase() === "true";
      const receivingTime = new Date();

      // 1. Insert Telemetry to InfluxDB (with sample timestamp = data_time & field sending_time)
      try {
        const point = new Point('telemetry')
          .tag('device_id', device.device_id)
          .floatField('temperature', validTemp !== null ? Number(validTemp) : (tempParsed !== null ? Number(tempParsed) : 0.0))
          .floatField('latitude', latitude !== null ? Number(latitude) : 0.0)
          .floatField('longitude', longitude !== null ? Number(longitude) : 0.0)
          .floatField('speed', Number(speed_knots || 0.0))
          .floatField('course', Number(course_deg || 0.0))
          .booleanField('valid', isValid)
          .intField('fault_code', faultCode)
          .booleanField('backup_record', isBackupRecord)
          .stringField('sending_time', receivingTime.toISOString());

        if (backupSequence !== null) {
          point.intField('backup_sequence', backupSequence);
        }
        if (csqVal !== null) {
          point.intField('csq', csqVal);
        }
        if (payload.roaming !== undefined) {
          point.booleanField('roaming', isRoaming);
        }

        // Set time-series point timestamp to sample timestamp (data_time)
        point.timestamp(ts);

        writeApi.writePoint(point);
        await writeApi.flush();
      } catch (err) {
        console.error("[InfluxDB] Failed to write telemetry point:", err);
      }

      // 2. Upsert DeviceStatus
      // For backup records: only update status if sample time is newer than existing last_seen_at
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

      let shouldUpdateStatus = created;
      if (!created) {
        const existingLastSeen = status.last_seen_at ? new Date(status.last_seen_at).getTime() : 0;
        const isNewer = ts.getTime() >= existingLastSeen;
        // Live packet always updates status; backup packet only updates if timestamp is newer
        if (!isBackupRecord || isNewer) {
          shouldUpdateStatus = true;
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
            last_seen_at: isNewer ? ts : status.last_seen_at,
          });
        }
      }

      // Broadcast single-device status and telemetry updates to connected live clients
      try {
        const fullStatus = status.toJSON ? status.toJSON() : status;
        const realtimeStatusPayload = {
          ...fullStatus,
          id: device.id,
          device_id: device.id, // Keep UUID matching for DB map state
          device_code: device.device_id, // String device code (e.g. DEMO000002)
          code: device.device_id,
          is_sensor_open: isSensorOpen,
          backup_record: isBackupRecord,
          csq: csqVal,
          devices: {
            id: device.id,
            device_id: device.device_id,
            name: device.name,
          }
        };

        if (shouldUpdateStatus) {
          broadcastRealtimeEvent("device_status_update", realtimeStatusPayload);
        }

        broadcastRealtimeEvent("telemetry_insert", {
          ts: ts.toISOString(),
          data_time: ts.toISOString(),
          sending_time: receivingTime.toISOString(),
          received_at: receivingTime.toISOString(),
          device_id: device.id,
          device_code: device.device_id,
          temperature_c: validTemp !== null ? Number(validTemp) : (tempParsed !== null ? Number(tempParsed) : null),
          latitude: latitude !== null ? Number(latitude) : null,
          longitude: longitude !== null ? Number(longitude) : null,
          speed_knots: Number(speed_knots || 0.0),
          course_deg: Number(course_deg || 0.0),
          valid: isValid,
          backup_record: isBackupRecord,
          backup_sequence: backupSequence,
          csq: csqVal,
          roaming: isRoaming,
          fault_code: faultCode
        });
      } catch (bcErr) {
        console.error("[MQTT] Realtime broadcast error:", bcErr);
      }

      // 3. Alarm Threshold Verification (ONLY for Live Data, NOT for offline backup records)
      if (device.alarm_enabled && !isBackupRecord) {
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

              // Send email with Asset name and Vehicle number
              const sent = await sendAlarmEmail(
                emails,
                device.device_id || device.name,
                device.Asset?.name || null,
                device.Asset?.vehicle_number || null,
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
