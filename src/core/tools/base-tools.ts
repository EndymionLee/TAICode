/**
 * 向后兼容 — 所有实现已迁移至 base/ + registry.ts
 */
export {
  toolsList, TOOL_MAP, deepCloneTools,
  getSandboxInstance, disposePowerShell,
  approvalFn, setApprovalFn,
  loadMCPTools, stopMCP, toolMeta,
} from "./registry.js";
