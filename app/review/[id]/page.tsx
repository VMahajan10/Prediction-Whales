import { notFound } from "next/navigation";
import { loadReviewPageData } from "@/lib/x-agent/loadReviewPageData";
import ReviewEditor from "./ReviewEditor";
import ReviewLoadError from "./ReviewLoadError";

export const dynamic = "force-dynamic";

interface ReviewPageProps {
  params: Promise<{ id: string }>;
}

export default async function ReviewPage({ params }: ReviewPageProps) {
  let queueId: string;

  try {
    const resolved = await params;
    queueId = resolved.id;
  } catch (error) {
    console.error("[review/[id]] Failed to resolve route params:", error);
    return (
      <ReviewLoadError
        title="Could not open review"
        message="The review link could not be parsed. Try opening the link from your email again."
      />
    );
  }

  try {
    const result = await loadReviewPageData(queueId);

    if (result.kind === "not_found") {
      notFound();
    }

    if (result.kind === "unavailable") {
      return (
        <ReviewLoadError title={result.title} message={result.message} />
      );
    }

    return <ReviewEditor {...result.props} />;
  } catch (error) {
    console.error("[review/[id]] Unexpected server error:", error);
    return (
      <ReviewLoadError
        title="Could not load review"
        message="An unexpected error occurred while loading this post. Try again in a moment."
      />
    );
  }
}
