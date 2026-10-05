/*
 * YAML language worker entry. Importing monaco-yaml's worker from a project
 * file (instead of `monaco-yaml/yaml.worker?worker`) lets Vite's dev server
 * pre-bundle it with its CommonJS dependencies (path-browserify, vscode-*),
 * which it would otherwise serve raw inside the worker.
 */
import "monaco-yaml/yaml.worker";
