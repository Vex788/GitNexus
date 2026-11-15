import { isBladeTemplateFilename } from 'gitnexus-shared';

/** Templates whose URLs and fetches can contribute route relationships to the graph. */
export const isTemplateRouteCandidate = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.endsWith('.html') ||
    normalized.endsWith('.htm') ||
    normalized.endsWith('.ejs') ||
    normalized.endsWith('.hbs') ||
    normalized.endsWith('.jsp') ||
    normalized.endsWith('.jspf') ||
    normalized.endsWith('.tag') ||
    normalized.endsWith('.xhtml') ||
    isBladeTemplateFilename(normalized)
  );
};
