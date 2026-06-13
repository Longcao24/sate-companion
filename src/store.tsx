import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { User } from "./protocol";

export interface Settings {
  serverUrl: string;
  token: string | null;
  user: User | null;
  demoMode: boolean;
  autoSync: boolean;
}

const DEFAULTS: Settings = {
  serverUrl: "https://api.sate.example.com",
  token: null,
  user: null,
  demoMode: true, // ships demo-first so the app works before backend/hardware
  autoSync: true,
};

interface Store {
  settings: Settings;
  ready: boolean;
  update: (patch: Partial<Settings>) => void;
  signOut: () => void;
}

const Ctx = createContext<Store | null>(null);
const KEY = "sate-companion-settings";

export function StoreProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) setSettings({ ...DEFAULTS, ...JSON.parse(raw) });
      })
      .finally(() => setReady(true));
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const signOut = () => update({ token: null, user: null });

  return (
    <Ctx.Provider value={{ settings, ready, update, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
