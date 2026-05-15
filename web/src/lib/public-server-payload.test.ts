import { describe, it, expect } from "bun:test";
import { buildPublicServerPayload, type PublicServer } from "./public-server-payload";

const baseRow = {
  id: "21632714-0b94-44ce-abbc-90ea5edcc729",
  name: "DSpawn BHOP",
  port: 27015,
  map: "bhop_colour",
  password: "secret",
  steam_login: "tritan270",
  steam_pass: "9kfenz94)?+",
  steam_2fa: "ABCDE",
  skip_update: 0,
  container_id: "0123abcd",
  created_at: "2026-04-27T20:12:00Z",
};

describe("buildPublicServerPayload", () => {
  it("returns the safe shape with no credentials", () => {
    const out = buildPublicServerPayload({
      row: baseRow,
      containerInfo: { state: "running", startedAt: "2026-05-07T18:04:11Z" },
      stats: { cpuPercent: 12.4, memoryMb: 1843, memoryLimitMb: 4096 },
      a2s: { players: 3, maxPlayers: 24 },
      now: new Date("2026-05-07T20:38:45Z"),
    });

    const expected: PublicServer = {
      id: "21632714-0b94-44ce-abbc-90ea5edcc729",
      name: "DSpawn BHOP",
      port: 27015,
      map: "bhop_colour",
      status: "running",
      players: 3,
      maxPlayers: 24,
      cpuPercent: 12.4,
      memoryMb: 1843,
      memoryLimitMb: 4096,
      memoryPercent: 45.0,
      startedAt: "2026-05-07T18:04:11Z",
      uptimeSeconds: 9274,
    };
    expect(out).toEqual(expected);
  });

  it("never includes any credential or internal field", () => {
    const out = buildPublicServerPayload({
      row: baseRow,
      containerInfo: { state: "running", startedAt: "2026-05-07T18:04:11Z" },
      stats: { cpuPercent: 0, memoryMb: 0, memoryLimitMb: 1 },
      a2s: { players: 0, maxPlayers: 0 },
      now: new Date(),
    });
    const forbidden = ["password", "steam_login", "steam_pass", "steam_2fa",
                       "container_id", "created_at", "skip_update"];
    for (const k of forbidden) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("returns 'unknown' when there is no container info", () => {
    const out = buildPublicServerPayload({
      row: baseRow,
      containerInfo: null,
      stats: null,
      a2s: null,
      now: new Date(),
    });
    expect(out.status).toBe("unknown");
    expect(out.startedAt).toBeNull();
    expect(out.uptimeSeconds).toBe(0);
  });

  it("clamps memoryPercent at 0 when memoryLimitMb is 0", () => {
    const out = buildPublicServerPayload({
      row: baseRow,
      containerInfo: { state: "running", startedAt: "2026-05-07T18:04:11Z" },
      stats: { cpuPercent: 5, memoryMb: 100, memoryLimitMb: 0 },
      a2s: null,
      now: new Date("2026-05-07T18:04:11Z"),
    });
    expect(out.memoryPercent).toBe(0);
  });
});
