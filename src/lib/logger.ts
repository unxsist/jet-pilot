import { invoke } from "@tauri-apps/api/core";

const log = (message: any, ...optionalParams: any[]) => {
  console.log(message, optionalParams);

  invoke("write_log", { level: "info", message });
};

const error = (message: any, ...optionalParams: any[]) => {
  console.log(message, optionalParams);

  invoke("write_log", { level: "error", message });
};

const warn = (message: any, ...optionalParams: any[]) => {
  console.log(message, optionalParams);

  invoke("write_log", { level: "warn", message });
};

const debug = (message: any, ...optionalParams: any[]) => {
  console.log(message, optionalParams);

  invoke("write_log", { level: "debug", message });
};

const trace = (message: any, ...optionalParams: any[]) => {
  console.log(message, optionalParams);

  invoke("write_log", { level: "trace", message });
};

export { log, debug, error, trace, warn };
