import "server-only";

export {
  buildTemplateCopyMap,
  clearTemplateCopyCacheForTests,
  defaultsMap,
  getLastTemplateCopySource,
  getTemplateCopyMap,
  getTemplateFamilyCopy,
  inspectRuntimeTemplateVariants,
  refreshTemplateCopyCache,
  setTemplateCopyCacheForTests,
  type RefreshTemplateCopyOptions,
  type TemplateCopySource,
} from "@/lib/templates/templateCopyLoader";
