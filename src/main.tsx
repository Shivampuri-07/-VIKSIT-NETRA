import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

const rootElement =
  document.getElementById("root");

if (!rootElement) {
  throw new Error(
    "AEGIS: root element #root was not found."
  );
}

createRoot(rootElement).render(
  <React.Fragment>
    <App />
  </React.Fragment>
);