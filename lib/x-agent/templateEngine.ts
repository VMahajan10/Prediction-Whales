/**
 * Strict Templates.md engine for X + Telegram draft generation.
 * Implementation lives in `@/lib/templates/postTemplates`.
 */
export {
  PostTemplateError,
  TEMPLATE_FAMILIES,
  getEligibleTemplateFamilies,
  sanitizePostDraft,
  selectAndRenderPostTemplate,
  selectPostTemplate,
  selectResolutionReceiptTemplate,
  type PostTemplateInputs,
  type PostTemplateSelection,
  type PostTemplateSelectionOptions,
  type TemplateFamily,
} from "@/lib/templates/postTemplates";

export {
  sanitizeTemplateSide,
  formatExplicitNoOutcome,
  MAX_TEMPLATE_SIDE_LENGTH,
} from "@/lib/x-agent/sideSanitizer";
