/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        'term': {
          'bg': '#000000',
          'green': '#00ff00',
          'yellow': '#ffff00',
          'red': '#ff0000',
          'bright-green': '#33ff00',
          'dim-green': '#00cc00'
        }
      },
      fontFamily: {
        'terminal': ['Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', 'monospace']
      }
    }
  },
  plugins: []
};