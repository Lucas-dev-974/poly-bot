import { render } from "solid-js/web";
import { App } from "./App";
import "./styles/variables.css";
import "./styles/globals.css";
import "./styles/components.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

render(() => <App />, root);
