import { Skeleton } from '@/components/ui/skeleton';


export default function Loading() {
  return (
    <div className="animate-in-fade" aria-busy="true" aria-label="Loading">
      <div className="mb-8 space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <Skeleton className="h-[340px] rounded-xl" />
        <Skeleton className="h-[340px] rounded-xl" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-52 rounded-xl" />
        <Skeleton className="h-52 rounded-xl" />
      </div>
    </div>
  );
}
