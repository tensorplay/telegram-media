import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Navbar } from "@/components/navbar";
import { MediaGrid } from "@/components/media-grid";
import { UploadDropzone } from "@/components/upload-dropzone";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default async function CreatorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: creator } = await supabase
    .from("creators")
    .select("*")
    .eq("slug", slug)
    .single();

  if (!creator) notFound();

  const { data: media } = await supabase
    .from("media")
    .select("*")
    .eq("creator_id", creator.id)
    .order("created_at", { ascending: false });

  return (
    <>
      <Navbar email={user?.email} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex items-center gap-2 mb-6">
          <Link href="/creators">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-2xl font-semibold">{creator.name}</h1>
          <span className="text-sm text-muted-foreground ml-2">
            {media?.length ?? 0} files
          </span>
        </div>

        <UploadDropzone creatorSlug={slug} creatorId={creator.id} />

        <MediaGrid media={media ?? []} />
      </main>
    </>
  );
}
