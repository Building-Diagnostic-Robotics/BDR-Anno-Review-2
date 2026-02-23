/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        anno: {
          bg: "#0C0C0E",
          surface: {
            low: "#141417",
            med: "#1C1C21",
            high: "#27272A",
          },
          primary: "#6366F1",
          secondary: "#A855F7",
          text: {
            main: "#FAFAFA",
            muted: "#A1A1AA",
          },
        },
      },
      borderRadius: {
        "anno-card": "1.25rem",
      },
    },
  },
  plugins: [],
};
