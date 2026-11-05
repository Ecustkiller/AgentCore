import { taskKeys } from "@/lib/queryKeys";
import { type HandoffJob, listUserHandoffJobs } from "@/services/handoff";
import { useQuery } from "@tanstack/react-query";

/** Statuses that still change server-side without a user action. */
export function isHandoffTaskRunning(job: HandoffJob): boolean {
  return job.status === "pending" || job.status === "running";
}

/** Finished work that still needs the user to inspect, merge, or retry. */
export function isHandoffTaskAwaitingUser(job: HandoffJob): boolean {
  return job.status === "succeeded" || job.status === "failed";
}

/**
 * Account-wide handoff jobs for the task center and sidebar affordance.
 *
 * The shared React Query cache means the shell and page do not duplicate the
 * request. Polling is scoped to jobs whose server-side status can still move; a
 * list of settled jobs stays quiet until the user refreshes it or dispatches
 * another handoff.
 */
export function useHandoffTasks() {
  return useQuery({
    queryKey: taskKeys.handoff,
    queryFn: listUserHandoffJobs,
    staleTime: 4_000,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      return jobs?.some(isHandoffTaskRunning) ? 4_000 : false;
    },
  });
}
