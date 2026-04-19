import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Navbar } from "@/components/navbar";
import { CreatorContent } from "@/components/creator-content";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

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
    .from("media_creators")
    .select("*")
    .eq("slug", slug)
    .single();

  if (!creator) notFound();

  // Supabase/PostgREST caps selects at 1000 rows by default, so page through
  // the media table until we've fetched everything for this creator.
  const PAGE_SIZE = 1000;
  async function fetchAllMedia() {
    const all: NonNullable<
      Awaited<ReturnType<typeof fetchMediaPage>>["data"]
    > = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await fetchMediaPage(from, from + PAGE_SIZE - 1);
      if (error || !data) break;
      all.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    return all;
  }
  function fetchMediaPage(from: number, to: number) {
    return supabase
      .from("media_files")
      .select(
        "id, filename, r2_key, content_type, size_bytes, created_at, ai_summary, ai_tags, folder_id"
      )
      .eq("creator_id", creator.id)
      .order("created_at", { ascending: false })
      .range(from, to);
  }

  const [media, { data: folders }] = await Promise.all([
    fetchAllMedia(),
    supabase
      .from("media_folders")
      .select("*")
      .eq("creator_id", creator.id)
      .order("name"),
  ]);

  return (
    <>
      <Navbar email={user?.email} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex items-center gap-2 mb-6">
          <Link href="/creators">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Link>
          <h1 className="text-2xl font-semibold">{creator.name}</h1>
          <span className="text-sm text-muted-foreground ml-2">
            {media.length} files
          </span>
        </div>

        <CreatorContent
          creatorSlug={slug}
          creatorId={creator.id}
          media={media}
          initialFolders={folders ?? []}
        />
      </main>
    </>
  );
}
