import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCcw, Square } from "lucide-react";
import { Link, useParams } from "react-router";
import { Badge, Button, ProgressBar } from "@eliteconverter/ui";
import { api } from "../lib/api";
import { usePageTitle } from "./hooks";

const terminal = new Set(["completed", "failed", "cancelled", "expired"]);

export default function Job() {
  const { jobId = "" } = useParams();
  usePageTitle(`Job ${jobId} - EliteConverter`);
  const queryClient = useQueryClient();
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId),
    refetchInterval: (query) => (terminal.has(query.state.data?.status ?? "") ? false : 2000),
    enabled: Boolean(jobId),
  });
  const eventsQuery = useQuery({
    queryKey: ["job-events", jobId],
    queryFn: () => api.events(jobId),
    enabled: Boolean(jobId),
  });
  const downloadQuery = useQuery({
    queryKey: ["job-download", jobId],
    queryFn: () => api.download(jobId),
    enabled: Boolean(jobId) && jobQuery.data?.status === "completed",
    staleTime: 60_000,
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancel(jobId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshDownload(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", jobId] });
      queryClient.invalidateQueries({ queryKey: ["job-download", jobId] });
    },
  });

  if (jobQuery.isLoading) return <div className="route-loading">Loading job...</div>;
  if (jobQuery.isError || !jobQuery.data) {
    return (
      <section className="page-section">
        <h1>Job not found</h1>
        <Link to="/convert">Start a new conversion</Link>
      </section>
    );
  }

  const job = jobQuery.data;
  return (
    <section className="page-section job-page">
      <div className="job-header">
        <div>
          <h1>{job.jobId}</h1>
          <p>{job.inputUrlRedacted}</p>
        </div>
        <Badge
          tone={
            job.status === "completed" ? "success" : job.status === "failed" ? "danger" : "warning"
          }
        >
          {job.status}
        </Badge>
      </div>
      <ProgressBar value={job.progress} label={`Conversion progress ${job.progress}%`} />
      <dl className="job-grid">
        <div>
          <dt>Stage</dt>
          <dd>{job.currentStage}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>{job.format.toUpperCase()}</dd>
        </div>
        <div>
          <dt>Quality</dt>
          <dd>{job.quality}</dd>
        </div>
        <div>
          <dt>Source host</dt>
          <dd>{job.sourceHostname}</dd>
        </div>
      </dl>
      {job.error ? (
        <p className="form-error" role="alert">
          {job.error.message}
        </p>
      ) : null}
      <div className="job-actions">
        <Button
          variant="secondary"
          onClick={() => cancel.mutate()}
          disabled={terminal.has(job.status)}
        >
          <Square aria-hidden="true" className="icon" /> Cancel
        </Button>
        <Button
          variant="secondary"
          onClick={() => refresh.mutate()}
          disabled={job.status !== "completed"}
        >
          <RefreshCcw aria-hidden="true" className="icon" /> Refresh URL
        </Button>
        <a
          className={downloadQuery.data?.url ? "primary-link" : "primary-link disabled"}
          href={downloadQuery.data?.url ?? "#"}
        >
          <Download aria-hidden="true" /> Download
        </a>
      </div>
      <section className="event-stream" aria-live="polite">
        <h2>Events</h2>
        <ol>
          {eventsQuery.data?.events.map((event) => (
            <li key={event.id}>
              <strong>{event.type}</strong>
              <span>{event.message}</span>
              <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
