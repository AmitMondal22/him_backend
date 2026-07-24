import { 
  Organization, Customer, Site, Asset, Device, DeviceStatus, Alarm 
} from "../models/index.js";
import { Point } from "@influxdata/influxdb-client";
import { writeApi, queryApi, bucket } from "../config/influx.js";

export const ensureInfluxData = async () => {
  try {
    const checkQuery = `
      from(bucket: "${bucket}")
        |> range(start: -7d)
        |> filter(fn: (r) => r["_measurement"] == "telemetry")
        |> limit(n: 1)
    `;
    const points = [];
    await new Promise((resolve) => {
      queryApi.queryRows(checkQuery, {
        next(row, tableMeta) {
          points.push(tableMeta.toObject(row));
        },
        error() {
          resolve();
        },
        complete() {
          resolve();
        }
      });
    });

    if (points.length === 0) {
      console.log("[DB Seeder] InfluxDB telemetry is empty. Seeding historical traces...");
      for (let k = 60; k >= 0; k--) {
        const ts = new Date(Date.now() - k * 60_000);
        const wave = Math.sin(k / 6) * 1.5;

        // Delhi (SLM0000001)
        writeApi.writePoint(new Point('telemetry')
          .tag('device_id', 'SLM0000001')
          .floatField('temperature', 5.4 + wave)
          .floatField('latitude', 28.5355)
          .floatField('longitude', 77.2910)
          .floatField('speed', 15.4)
          .floatField('course', 291.0)
          .booleanField('valid', true)
          .timestamp(ts));

        // Mumbai (SLM0000002)
        writeApi.writePoint(new Point('telemetry')
          .tag('device_id', 'SLM0000002')
          .floatField('temperature', 12.4 + wave)
          .floatField('latitude', 19.0760)
          .floatField('longitude', 72.9987)
          .floatField('speed', 25.4)
          .floatField('course', 120.0)
          .booleanField('valid', true)
          .timestamp(ts));

        // Bengaluru (SLM0000003)
        writeApi.writePoint(new Point('telemetry')
          .tag('device_id', 'SLM0000003')
          .floatField('temperature', -3.5 + wave)
          .floatField('latitude', 12.8452)
          .floatField('longitude', 77.6602)
          .floatField('speed', 0.0)
          .floatField('course', 180.0)
          .booleanField('valid', true)
          .timestamp(ts));

        // Noida (SLM0000004)
        writeApi.writePoint(new Point('telemetry')
          .tag('device_id', 'SLM0000004')
          .floatField('temperature', 5.0 + wave)
          .floatField('latitude', 28.5355)
          .floatField('longitude', 77.3910)
          .floatField('speed', 0.0)
          .floatField('course', 45.0)
          .booleanField('valid', true)
          .timestamp(ts));

        // Bengaluru North (SLM0000005)
        writeApi.writePoint(new Point('telemetry')
          .tag('device_id', 'SLM0000005')
          .floatField('temperature', 4.2 + wave)
          .floatField('latitude', 13.0250)
          .floatField('longitude', 77.5900)
          .floatField('speed', 0.0)
          .floatField('course', 90.0)
          .booleanField('valid', true)
          .timestamp(ts));
      }
      await writeApi.flush();
      console.log("[DB Seeder] Seeded InfluxDB historical logs successfully.");
    }
  } catch (err) {
    console.error("[DB Seeder] InfluxDB check/seed failed:", err);
  }
};

export const seedDatabaseProgrammatically = async () => {
  try {
    const customerCount = await Customer.count();
    if (customerCount > 0) {
      console.log("[DB Seeder] Database already populated. Skipping seeder.");
      return;
    }

    console.log("[DB Seeder] Database is empty. Seeding initial dummy data...");

    // 1. Create Organization
    const org = await Organization.create({ name: "Igtam Technologies" });

    // 2. Create Customers
    const customers = await Customer.bulkCreate([
      { organization_id: org.id, name: "ColdChain Logistics India", contact_email: "ops@coldchain.in", contact_phone: "+91 98100 00001" },
      { organization_id: org.id, name: "MediPharma Distributors", contact_email: "logistics@medipharma.in", contact_phone: "+91 98100 00002" },
      { organization_id: org.id, name: "FreshFrost Foods", contact_email: "fleet@freshfrost.in", contact_phone: "+91 98100 00003" }
    ], { returning: true });

    // 3. Create Sites
    const sites = await Site.bulkCreate([
      { customer_id: customers[0].id, name: "Delhi Central Hub", address: "Okhla Phase III, New Delhi", latitude: 28.5355, longitude: 77.2910 },
      { customer_id: customers[1].id, name: "Mumbai Vashi Depot", address: "APMC Market, Vashi, Navi Mumbai", latitude: 19.0760, longitude: 72.9987 },
      { customer_id: customers[2].id, name: "Bengaluru South Cold Store", address: "Electronic City, Bengaluru", latitude: 12.8452, longitude: 77.6602 }
    ], { returning: true });

    // 4. Create Assets
    const assets = await Asset.bulkCreate([
      { customer_id: customers[0].id, site_id: sites[0].id, name: "Truck-CO-100", vehicle_number: "IN DL 01 AB 1000", kind: "vehicle" },
      { customer_id: customers[1].id, site_id: sites[1].id, name: "Truck-ME-101", vehicle_number: "IN MH 02 AB 1001", kind: "vehicle" },
      { customer_id: customers[2].id, site_id: sites[2].id, name: "Truck-FR-102", vehicle_number: "IN KA 03 AB 1002", kind: "vehicle" }
    ], { returning: true });

    // 5. Create Devices (1 to 5)
    const devices = await Device.bulkCreate([
      { customer_id: customers[0].id, site_id: sites[0].id, asset_id: assets[0].id, device_id: "SLM0000001", imei: "863110081000001", name: "Logger SLM0000001", sensor_type: "MAX31856", thermocouple_type: "K", low_threshold: 2.0, high_threshold: 8.0, upload_interval_s: 60, installed_at: new Date(Date.now() - 30 * 86400000) },
      { customer_id: customers[1].id, site_id: sites[1].id, asset_id: assets[1].id, device_id: "SLM0000002", imei: "863110081000002", name: "Logger SLM0000002", sensor_type: "MAX31856", thermocouple_type: "K", low_threshold: 2.0, high_threshold: 8.0, upload_interval_s: 60, installed_at: new Date(Date.now() - 31 * 86400000) },
      { customer_id: customers[2].id, site_id: sites[2].id, asset_id: assets[2].id, device_id: "SLM0000003", imei: "863110081000003", name: "Logger SLM0000003", sensor_type: "MAX31856", thermocouple_type: "K", low_threshold: 2.0, high_threshold: 8.0, upload_interval_s: 60, installed_at: new Date(Date.now() - 32 * 86400000) },
      { customer_id: customers[0].id, site_id: sites[0].id, asset_id: assets[0].id, device_id: "SLM0000004", imei: "863110081000004", name: "Logger SLM0000004", sensor_type: "MAX31856", thermocouple_type: "K", low_threshold: 2.0, high_threshold: 8.0, upload_interval_s: 60, installed_at: new Date(Date.now() - 33 * 86400000) },
      { customer_id: customers[2].id, site_id: sites[2].id, asset_id: assets[2].id, device_id: "SLM0000005", imei: "863110081000005", name: "Logger SLM0000005", sensor_type: "MAX31856", thermocouple_type: "K", low_threshold: 2.0, high_threshold: 8.0, upload_interval_s: 60, installed_at: new Date(Date.now() - 34 * 86400000) }
    ], { returning: true });

    // 6. Create Device Statuses
    await DeviceStatus.bulkCreate([
      { device_id: devices[0].id, temperature_c: 5.4, latitude: 28.5355, longitude: 77.2910, speed_knots: 15.4, satellites: 10, firmware_version: "2.0.4", config_version: "1.0.0", connection_state: "online", last_seen_at: new Date(), last_startup_at: new Date(Date.now() - 3600_000) },
      { device_id: devices[1].id, temperature_c: 12.4, latitude: 19.0760, longitude: 72.9987, speed_knots: 25.4, satellites: 11, firmware_version: "2.0.5", config_version: "1.0.0", connection_state: "online", last_seen_at: new Date(), last_startup_at: new Date(Date.now() - 3600_000) },
      { device_id: devices[2].id, temperature_c: -3.5, latitude: 12.8452, longitude: 77.6602, speed_knots: 0.0, satellites: 9, firmware_version: "2.0.5", config_version: "1.0.0", connection_state: "online", last_seen_at: new Date(), last_startup_at: new Date(Date.now() - 3600_000) },
      { device_id: devices[3].id, temperature_c: 5.0, latitude: 28.5355, longitude: 77.3910, speed_knots: 0.0, satellites: 10, firmware_version: "2.0.5", config_version: "1.0.0", connection_state: "online", last_seen_at: new Date(), last_startup_at: new Date(Date.now() - 3600_000) },
      { device_id: devices[4].id, temperature_c: 4.2, latitude: 13.0250, longitude: 77.5900, speed_knots: 0.0, satellites: 9, firmware_version: "2.0.5", config_version: "1.0.0", connection_state: "online", last_seen_at: new Date(), last_startup_at: new Date(Date.now() - 3600_000) }
    ]);

    // 7. Create Telemetry History Trails in InfluxDB (Delhi, Mumbai, Bengaluru)
    console.log("[DB Seeder] Seeding timeseries history to InfluxDB...");
    for (let k = 60; k >= 0; k--) {
      const ts = new Date(Date.now() - k * 60_000);
      const wave = Math.sin(k / 6) * 1.5;

      // Delhi (SLM0000001)
      writeApi.writePoint(new Point('telemetry')
        .tag('device_id', 'SLM0000001')
        .floatField('temperature', 5.4 + wave)
        .floatField('latitude', 28.5355)
        .floatField('longitude', 77.2910)
        .floatField('speed', 15.4)
        .floatField('course', 291.0)
        .booleanField('valid', true)
        .timestamp(ts));

      // Mumbai (SLM0000002)
      writeApi.writePoint(new Point('telemetry')
        .tag('device_id', 'SLM0000002')
        .floatField('temperature', 12.4 + wave)
        .floatField('latitude', 19.0760)
        .floatField('longitude', 72.9987)
        .floatField('speed', 25.4)
        .floatField('course', 120.0)
        .booleanField('valid', true)
        .timestamp(ts));

      // Bengaluru (SLM0000003)
      writeApi.writePoint(new Point('telemetry')
        .tag('device_id', 'SLM0000003')
        .floatField('temperature', -3.5 + wave)
        .floatField('latitude', 12.8452)
        .floatField('longitude', 77.6602)
        .floatField('speed', 0.0)
        .floatField('course', 180.0)
        .booleanField('valid', true)
        .timestamp(ts));

      // Noida (SLM0000004)
      writeApi.writePoint(new Point('telemetry')
        .tag('device_id', 'SLM0000004')
        .floatField('temperature', 5.0 + wave)
        .floatField('latitude', 28.5355)
        .floatField('longitude', 77.3910)
        .floatField('speed', 0.0)
        .floatField('course', 45.0)
        .booleanField('valid', true)
        .timestamp(ts));

      // Bengaluru North (SLM0000005)
      writeApi.writePoint(new Point('telemetry')
        .tag('device_id', 'SLM0000005')
        .floatField('temperature', 4.2 + wave)
        .floatField('latitude', 13.0250)
        .floatField('longitude', 77.5900)
        .floatField('speed', 0.0)
        .floatField('course', 90.0)
        .booleanField('valid', true)
        .timestamp(ts));
    }
    await writeApi.flush();

    // 8. Create Active Alarms
    await Alarm.bulkCreate([
      { device_id: devices[1].id, customer_id: customers[1].id, alarm_type: "high_temp", severity: "critical", active: true, first_occurred_at: new Date(Date.now() - 30 * 60_000), last_occurred_at: new Date(Date.now() - 60_000), occurrences: 15, value: 12.4, message: "Temperature above high threshold" },
      { device_id: devices[2].id, customer_id: customers[2].id, alarm_type: "low_temp", severity: "critical", active: true, first_occurred_at: new Date(Date.now() - 30 * 60_000), last_occurred_at: new Date(Date.now() - 60_000), occurrences: 15, value: -3.5, message: "Temperature below low threshold" }
    ]);

    console.log("[DB Seeder] Seeding dummy data completed successfully.");
  } catch (error) {
    console.error("[DB Seeder] Seeding error:", error);
  }
};
