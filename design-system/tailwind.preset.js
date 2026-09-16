/**
 * SATE design system — Tailwind preset.
 *
 * For React apps (react_app_sate-ui_update and anything new). Drop it in:
 *
 *   // tailwind.config.js
 *   import sate from '../design-system/tailwind.preset.js';
 *   export default { presets: [sate], content: ['./index.html', './src/**\/*.{ts,tsx}'] };
 *
 * The point of the preset is that you keep writing the utilities the app already
 * uses — `bg-white`, `border-gray-200`, `text-gray-600`, `rounded-lg`, `shadow-sm` —
 * and they now resolve to the audited token values. Named aliases (`bg-sate-primary`,
 * `text-sate-muted`) exist for new code that wants to state intent.
 *
 * ⚠️ This preset FIXES a live bug: the current tailwind.config.js maps every fontSize
 * utility to `var(--text-*)`, and nothing defines those variables — so `.text-sm`
 * emits an invalid declaration and changes no size at all. The scale below uses
 * literal rem values. If you keep the var-based approach instead, you MUST also load
 * sate.css, which defines them.
 *
 * Values mirror tokens.json. Change tokens.json first, then this file.
 */

const gray = {
  50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af',
  500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827',
};

/** Semantic annotation colours. These carry meaning — never reuse one decoratively. */
const annotation = {
  pause: '#3b82f6',
  filler: '#f59e0b',
  repetition: '#eab308',
  mispronunciation: '#8b5cf6',
  morpheme: '#10b981',
  revision: '#f97316',
  'utterance-error': '#ef4444',
  'morpheme-omission': '#dc2626',
  stuttering: '#3b82f6',
};

/** The transcript highlight behind an annotated word (lighter than the marker colour). */
const annotationBg = {
  pause: '#bfdbfe',
  filler: '#fed7aa',
  repetition: '#fef08a',
  mispronunciation: '#e9d5ff',
  morpheme: '#bbf7d0',
  revision: '#fed7aa',
  'utterance-error': '#fecaca',
  'morpheme-omission': '#fecaca',
  stuttering: '#93c5fd',
};

export default {
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1240px' } },

    extend: {
      colors: {
        gray,

        // Named tokens for new code. `bg-sate-primary` states intent in a way
        // `bg-blue-600` does not, but both resolve to the same #2563eb.
        sate: {
          primary: '#2563eb',
          'primary-hover': '#1d4ed8',
          'primary-soft': '#eff6ff',
          'primary-border': '#bfdbfe',
          page: '#fafafa',
          raised: '#ffffff',
          sunken: '#f9fafb',
          border: '#e5e7eb',
          'border-strong': '#d1d5db',
          text: '#111827',
          'text-2': '#374151',
          muted: '#4b5563',
          subtle: '#6b7280',
          faint: '#9ca3af',
        },

        annotation,
        'annotation-bg': annotationBg,

        success: { DEFAULT: '#16a34a', soft: '#f0fdf4', border: '#bbf7d0', text: '#15803d' },
        warning: { DEFAULT: '#d97706', soft: '#fffbeb', border: '#fde68a', text: '#b45309' },
        danger:  { DEFAULT: '#dc2626', soft: '#fef2f2', border: '#fecaca', text: '#b91c1c' },
      },

      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Oxygen',
               'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },

      // Literal values, not var(--text-*) — see the warning at the top of this file.
      fontSize: {
        xs:   ['0.75rem',  { lineHeight: '1rem' }],
        sm:   ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem',     { lineHeight: '1.5rem' }],
        lg:   ['1.125rem', { lineHeight: '1.75rem' }],
        xl:   ['1.25rem',  { lineHeight: '1.75rem' }],
        '2xl':['1.5rem',   { lineHeight: '2rem' }],
        '3xl':['1.875rem', { lineHeight: '2.25rem' }],
      },

      borderRadius: { sm: '4px', md: '6px', lg: '8px', xl: '12px' },

      boxShadow: {
        sm: '0 1px 2px 0 rgba(0, 0, 0, .05)',
        DEFAULT: '0 1px 2px 0 rgba(0, 0, 0, .05)',
        md: '0 4px 6px -1px rgba(0, 0, 0, .1), 0 2px 4px -2px rgba(0, 0, 0, .1)',
        lg: '0 10px 15px -3px rgba(0, 0, 0, .1), 0 4px 6px -4px rgba(0, 0, 0, .1)',
        modal: '0 4px 20px rgba(0, 0, 0, .15)',
      },

      maxWidth: { content: '1240px', prose: '880px' },

      transitionDuration: { fast: '120ms', normal: '200ms' },

      keyframes: {
        'modal-in': {
          '0%':   { opacity: '0', transform: 'scale(.95) translateY(-10px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
      },
      animation: { 'modal-in': 'modal-in .2s ease-out' },
    },
  },
  plugins: [],
};
