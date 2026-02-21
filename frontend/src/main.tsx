import React from "react";
import ReactDOM from "react-dom/client";

function App() {
  return (
    <main style={{ fontFamily: "sans-serif", margin: "2rem" }}>
      <h1>bdr-anno-review</h1>
      <p>Frontend scaffold initialized. See ARCHITECTURE.md for workflow targets.</p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
