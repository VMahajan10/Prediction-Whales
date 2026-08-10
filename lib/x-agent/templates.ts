/**
 * @deprecated Import from `@/lib/x-agent/templateEngine` instead.
 * Re-exported for backward compatibility with existing x-agent imports.
 */
import {
  PostTemplateError,
  sanitizePostDraft,
  selectPostTemplate,
  TEMPLATE_FAMILIES,
  type PostTemplateInputs,
  type TemplateFamily,
} from "@/lib/x-agent/templateEngine";

export {
  TEMPLATE_FAMILIES,
  type TemplateFamily,
  sanitizePostDraft as sanitizeXPostCopy,
};

export type TemplateSchemaInputs = PostTemplateInputs;

export class TemplateGenerationError extends PostTemplateError {
  constructor(message: string) {
    super(message);
    this.name = "TemplateGenerationError";
  }
}

export function generateXPostCopy(
  data: TemplateSchemaInputs,
  lastFamilyUsed?: string,
  random = Math.random
): { copyText: string; family: string; variantId: string } {
  const selection = selectPostTemplate(data, {
    lastTemplateFamily: lastFamilyUsed,
    random,
  });

  return {
    copyText: selection.renderedDraft,
    family: selection.templateFamily,
    variantId: selection.variantId,
  };
}
