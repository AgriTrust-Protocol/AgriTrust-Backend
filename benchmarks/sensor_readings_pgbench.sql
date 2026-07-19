\set farm random(1, 10000)
\set sensor random(1, 100000)
\set sensor_type random(1, 6)
\set value random_gaussian(1500, 250, 6)
INSERT INTO sensor_readings (farm_id, sensor_id, sensor_type, ts, value, unit, tags)
VALUES (
  md5(:farm::text)::uuid,
  md5(:sensor::text)::uuid,
  ('{temperature,humidity,soil_moisture,ph,wind,rain}'::text[])[:sensor_type],
  clock_timestamp(),
  :value / 100.0,
  'metric',
  jsonb_build_object('source', 'pgbench', 'firmware', 'v1')
);
