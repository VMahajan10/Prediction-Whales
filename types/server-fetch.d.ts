/** Next.js / undici fetch extensions used in shared lib fetch helpers. */
interface RequestInit {
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
  cache?: RequestCache;
}
