import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// Runs in Node.js — no client-side code here.

const config: Config = {
  title: 'SATE Companion — Internal',
  tagline: 'Detailed engineering handbook · private',
  favicon: 'img/sate-mark.png',

  stylesheets: [
    {
      href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
      rel: 'stylesheet',
    },
  ],

  future: {v4: true},

  // Update these for your deploy target (e.g. Cloudflare Pages / GitHub Pages).
  url: 'https://docs.example.com',
  baseUrl: '/',

  organizationName: 'sate',
  projectName: 'sate-docs-internal',

  onBrokenLinks: 'warn',
  onBrokenAnchors: 'warn',

  i18n: {defaultLocale: 'en', locales: ['en']},

  // 'detect' → .md files keep the CommonMark parser (safe with the <UPPER> and
  // {braces} that appear throughout these docs); only .mdx uses the MDX/JSX parser.
  markdown: {
    format: 'detect',
    mermaid: true,
    hooks: {onBrokenMarkdownLinks: 'warn'},
  },
  themes: [
    '@docusaurus/theme-mermaid',
    // Offline full-text search — no external service (industrial-friendly).
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {hashed: true, indexDocs: true, docsRouteBasePath: '/', highlightSearchTermsOnTargetPage: true},
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',                   // the real, structured documentation set
          routeBasePath: '/',             // docs live at the site root
          sidebarPath: './sidebars.ts',
        },
        blog: false,                       // pure documentation site
        theme: {customCss: './src/css/custom.css'},
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {defaultMode: 'dark', respectPrefersColorScheme: true},
    // Legible, monochrome-friendly diagrams in both themes. 'neutral' + 'dark'
    // are the cleanest built-ins; Inter keeps them consistent with the UI, and a
    // larger base font stops complex flows from rendering as tiny text.
    mermaid: {
      theme: {light: 'neutral', dark: 'dark'},
      options: {
        fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
        fontSize: 15,
        flowchart: {useMaxWidth: true, htmlLabels: true, curve: 'basis', padding: 18, nodeSpacing: 45, rankSpacing: 55},
        sequence: {useMaxWidth: true, mirrorActors: false, actorMargin: 60, messageFontSize: 14, noteFontSize: 13},
        stateDiagram: {useMaxWidth: true},
        er: {useMaxWidth: true},
      },
    },
    navbar: {
      title: 'SATE Internal',
      logo: {
        alt: 'SATE',
        src: 'img/sate-mark.png',
      },
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Handbook'},
      ],
    },
    footer: {
      style: 'dark',
      links: [],
      copyright: 'SATE Companion — internal engineering handbook · confidential.',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['cpp', 'bash', 'python', 'sql', 'toml', 'ini', 'diff', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
