import React, { useMemo, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { makeApi } from "./src/api/sateApi";
import { makeLink } from "./src/ble/SateBle";
import { ManagedDevice } from "./src/protocol";
import { DeviceDetailScreen } from "./src/screens/DeviceDetailScreen";
import { DevicesScreen } from "./src/screens/DevicesScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { ProvisionScreen } from "./src/screens/ProvisionScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { StoreProvider, useStore } from "./src/store";
import { useAutoSync } from "./src/sync/AutoSync";
import { C } from "./src/theme";

type Screen =
  | { name: "devices" }
  | { name: "device"; device: ManagedDevice }
  | { name: "provision" }
  | { name: "settings" };

function Root() {
  const { settings, ready } = useStore();
  const [screen, setScreen] = useState<Screen>({ name: "devices" });

  const api = useMemo(
    () => makeApi(settings.serverUrl, settings.token, settings.demoMode),
    [settings.serverUrl, settings.token, settings.demoMode]
  );
  const link = useMemo(() => makeLink(settings.demoMode), [settings.demoMode]);

  // Auto BLE bridge sync runs whenever signed in + enabled, except while
  // the provisioning flow or the device-detail screen (nearby BLE control)
  // needs the radio.
  const syncEnabled =
    settings.autoSync && screen.name !== "provision" && screen.name !== "device";
  const activity = useAutoSync(syncEnabled, link, api, !!settings.token);

  if (!ready) return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  if (!settings.token) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginScreen />
      </>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      {screen.name === "devices" && (
        <DevicesScreen
          api={api}
          activity={activity}
          onOpenDevice={(d) => setScreen({ name: "device", device: d })}
          onAddDevice={() => setScreen({ name: "provision" })}
          onOpenSettings={() => setScreen({ name: "settings" })}
        />
      )}
      {screen.name === "device" && (
        <DeviceDetailScreen
          api={api}
          link={link}
          device={screen.device}
          onClose={() => setScreen({ name: "devices" })}
        />
      )}
      {screen.name === "provision" && (
        <ProvisionScreen
          api={api}
          link={link}
          onClose={() => setScreen({ name: "devices" })}
        />
      )}
      {screen.name === "settings" && (
        <SettingsScreen onClose={() => setScreen({ name: "devices" })} />
      )}
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Root />
    </StoreProvider>
  );
}
