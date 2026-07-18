export const MANAGED_COMPONENTS_PROMPT = `
WorkX can install trusted optional components into its private ~/.workx/components directory.
- Use component_list to inspect catalog capabilities and installation state before claiming a component is available.
- A catalog entry or successful installation is capability inventory, not an analysis execution path.
- Use component_install only when an optional capability is necessary for the current request and an available WorkX tool or workflow can actually invoke that component afterward.
- If no execution path is available, explain that missing integration instead of requesting an installation that cannot complete the task.
- Explain the immediate need in the reason field. Installation always requires explicit user approval.
- Never install WorkX dependencies through terminal package managers, curl scripts, or arbitrary URLs.
- A successful installation does not itself perform the user's task; continue the original workflow afterward.
`.trim();
