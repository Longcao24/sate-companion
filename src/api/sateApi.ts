// SATE server API client. The companion app signs in with the SAME SLP
// account as the SATE web app; claimed devices are stored under that
// account. A full in-memory mock implements the same interface so the
// whole app runs in demo mode with no backend.
//
// REST endpoints (Bearer <token> unless noted):
//   POST  /api/auth/login                { email, password } -> { token, user }
//   GET   /api/devices                   -> ManagedDevice[]
//   POST  /api/devices/claim-token      -> { token }   (binds to this account)
//   PATCH /api/devices/:id               { name }
//   DELETE /api/devices/:id
//   POST  /api/devices/:id/commands      { op: RemoteCommand }
//   GET   /api/patients                  -> Patient[]
//   POST  /api/sessions                  { device_serial, patient_id,
//                                          session_number, sample_rate,
//                                          wav_base64 } -> { id }

import {
  ManagedDevice,
  Patient,
  RemoteCommand,
  User,
} from "../protocol";

export interface SateApi {
  login(email: string, password: string): Promise<{ token: string; user: User }>;
  listDevices(): Promise<ManagedDevice[]>;
  claimToken(): Promise<string>;
  renameDevice(id: string, name: string): Promise<void>;
  removeDevice(id: string): Promise<void>;
  sendCommand(id: string, op: RemoteCommand): Promise<void>;
  listPatients(): Promise<Patient[]>;
  uploadSession(args: {
    device_serial: string;
    patient_id: string;
    session_number: number;
    sample_rate: number;
    wav_base64: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------- real API

export class HttpApi implements SateApi {
  constructor(private baseUrl: string, private token: string | null) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${body || res.statusText}`);
    }
    return res.status === 204 ? (undefined as T) : res.json();
  }

  login(email: string, password: string) {
    return this.req<{ token: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  listDevices() {
    return this.req<ManagedDevice[]>("/api/devices");
  }
  async claimToken() {
    const r = await this.req<{ token: string }>("/api/devices/claim-token", {
      method: "POST",
    });
    return r.token;
  }
  async renameDevice(id: string, name: string) {
    await this.req(`/api/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }
  async removeDevice(id: string) {
    await this.req(`/api/devices/${id}`, { method: "DELETE" });
  }
  async sendCommand(id: string, op: RemoteCommand) {
    await this.req(`/api/devices/${id}/commands`, {
      method: "POST",
      body: JSON.stringify({ op }),
    });
  }
  listPatients() {
    return this.req<Patient[]>("/api/patients");
  }
  async uploadSession(args: {
    device_serial: string;
    patient_id: string;
    session_number: number;
    sample_rate: number;
    wav_base64: string;
  }) {
    await this.req("/api/sessions", {
      method: "POST",
      body: JSON.stringify(args),
    });
  }
}

// ---------------------------------------------------------------- mock API

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockApi implements SateApi {
  private static devices: ManagedDevice[] = [
    {
      id: "dev-001",
      name: "Therapy Room 1",
      serial: "SATE-7C3A01",
      fw: "0.5.0",
      online: true,
      ip: "192.168.1.42",
      last_seen: new Date().toISOString(),
      pending_sessions: 0,
    },
    {
      id: "dev-002",
      name: "Therapy Room 2",
      serial: "SATE-7C3A02",
      fw: "0.5.0",
      online: false,
      last_seen: new Date(Date.now() - 3600e3).toISOString(),
      pending_sessions: 2,
    },
  ];

  async login(email: string, _password: string) {
    await sleep(500);
    return {
      token: "demo-token",
      user: { id: "u-1", name: "SLP Morgan", email },
    };
  }
  async listDevices() {
    await sleep(300);
    return MockApi.devices.map((d) => ({ ...d }));
  }
  async claimToken() {
    await sleep(200);
    return "claim-" + Math.random().toString(36).slice(2, 8);
  }
  async renameDevice(id: string, name: string) {
    const d = MockApi.devices.find((x) => x.id === id);
    if (d) d.name = name;
  }
  async removeDevice(id: string) {
    MockApi.devices = MockApi.devices.filter((x) => x.id !== id);
  }
  async sendCommand(id: string, op: RemoteCommand) {
    await sleep(400);
    const d = MockApi.devices.find((x) => x.id === id);
    if (!d) throw new Error("device not found");
    if (!d.online) throw new Error("Device is offline - command queued");
    if (op === "sync_now") d.pending_sessions = 0;
  }
  async listPatients() {
    await sleep(200);
    return [
      { patient_id: "PT-1001", name: "Maya Nguyen", age: "7y 4m", session_type: "Articulation", clinician: "Dr. Taylor" },
      { patient_id: "PT-1002", name: "Ethan Brooks", age: "5y 9m", session_type: "Language Sample", clinician: "SLP Morgan" },
      { patient_id: "PT-1003", name: "Sophia Patel", age: "9y 1m", session_type: "Fluency", clinician: "SLP Rivera" },
    ];
  }
  async uploadSession() {
    await sleep(700);
  }

  /** demo helper: a freshly provisioned device appears in the account */
  static addClaimed(serial: string, name: string) {
    MockApi.devices.push({
      id: "dev-" + serial.toLowerCase(),
      name,
      serial,
      fw: "0.5.0",
      online: true,
      ip: "192.168.1.77",
      last_seen: new Date().toISOString(),
      pending_sessions: 0,
    });
  }
}

export function makeApi(serverUrl: string, token: string | null, demo: boolean): SateApi {
  return demo ? new MockApi() : new HttpApi(serverUrl, token);
}
