/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        anno: {
          bg: "#ece5db",
          line: "#d7cbbd",
          primary: "#2f7a6b",
          "primary-strong": "#255f53",
          accent: "#c48753",
          warning: "#bd7a37",
          danger: "#b45a58",
          info: "#648395",
          success: "#4b8363",
          surface: {
            low: "#f8f3eb",
            med: "#efe5d8",
            high: "#e2d4c2",
            ink: "#222a31",
          },
          text: {
            main: "#281f18",
            muted: "#675d56",
            subtle: "#877b72",
            inverse: "#f8f4ed",
          },
        },
      },
      boxShadow: {
        studio: "0 16px 40px rgba(102, 79, 51, 0.12)",
      },
    },
  },
  plugins: [],
};
