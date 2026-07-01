import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Activity, Database, Network, ServerCog } from "lucide-react";
import { Badge } from "@eliteconverter/ui";
import { api } from "../lib/api";
import { usePageTitle } from "./hooks";

export default function Status() {
  usePageTitle("Status - EliteConverter");
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const data = status.data;

  return (
    <section className="page-section">
      <div className="section-head">
        <h1>Status</h1>
        <p>Generalized health information for the API, database, queue and provider network.</p>
      </div>
      <div className="status-grid">
        <StatusItem icon={<Activity />} label="API" value={data?.api ?? "degraded"} />
        <StatusItem icon={<Database />} label="Database" value={data?.database ?? "degraded"} />
        <StatusItem icon={<ServerCog />} label="Queue" value={data?.queue ?? "degraded"} />
        <StatusItem
          icon={<Network />}
          label="Provider network"
          value={data?.providerNetwork ?? "degraded"}
        />
      </div>
      <section className="event-stream">
        <h2>Recent incidents</h2>
        {data?.incidents.length ? (
          <ol>
            {data.incidents.map((incident) => (
              <li key={incident.id}>
                <strong>{incident.title}</strong>
                <span>{incident.message}</span>
                <time dateTime={incident.updatedAt}>
                  {new Date(incident.updatedAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p>No active incidents.</p>
        )}
      </section>
    </section>
  );
}

const StatusItem = ({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: "operational" | "degraded" | "outage";
}) => (
  <div className="status-item">
    {icon}
    <span>{label}</span>
    <Badge tone={value === "operational" ? "success" : value === "degraded" ? "warning" : "danger"}>
      {value}
    </Badge>
  </div>
);
