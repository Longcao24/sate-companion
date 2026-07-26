import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// Grouped sidebar (Plaud/Mintlify-style bold section headers).
const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Introduction',
      collapsed: false,
      items: ['intro', 'architecture', 'getting-started'],
    },
    {
      type: 'category',
      label: 'Component guides',
      collapsed: false,
      items: [
        'guides/recorder',
        'guides/pendant',
        'guides/mobile-app',
        'guides/web-app',
        'guides/backend',
        'guides/plaud',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: ['reference/device-api', 'reference/ble-protocol', 'reference/data-model', 'reference/cli'],
    },
    {
      type: 'category',
      label: 'Operations',
      collapsed: false,
      items: [
        'operations/firmware-release',
        'operations/hardware-testing',
        'operations/troubleshooting',
      ],
    },
    {
      type: 'category',
      label: 'Project status',
      collapsed: false,
      items: ['known-issues', 'changelog'],
    },
  ],
};

export default sidebars;
