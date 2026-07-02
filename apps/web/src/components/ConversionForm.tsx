import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, ShieldCheck } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { Button, Field } from "@eliteconverter/ui";
import { api } from "../lib/api";

const schema = z.object({
  url: z.string().url("Enter a valid media URL").max(4096),
  format: z.string().min(1),
  quality: z.string().min(1),
  callbackUrl: z.string().url("Enter a valid callback URL").optional().or(z.literal("")),
  permissionConfirmed: z
    .boolean()
    .refine((value) => value, "Confirm that you own or have permission to process this media"),
});

type FormValues = z.infer<typeof schema>;

export const ConversionForm = ({ compact = false }: { compact?: boolean }) => {
  const navigate = useNavigate();
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities });
  const formats = capabilities.data?.formats ?? ["mp4", "webm", "mkv", "mp3", "m4a"];
  const qualities = capabilities.data?.qualities ?? ["source", "1080p", "720p", "480p", "audio"];
  const defaultUrl = useMemo(() => "https://media.example.com/input.mp4?mock=success", []);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      url: defaultUrl,
      format: "mp4",
      quality: "source",
      callbackUrl: "",
      permissionConfirmed: false,
    },
  });
  const selectedFormat = form.watch("format");
  const availableQualities =
    capabilities.data?.qualityFormats[
      selectedFormat as keyof typeof capabilities.data.qualityFormats
    ] ?? qualities;

  useEffect(() => {
    if (!availableQualities.includes(form.getValues("quality") as never)) {
      form.setValue("quality", availableQualities[0] ?? "source");
    }
  }, [availableQualities, form]);

  const mutation = useMutation({
    mutationFn: api.createPublicConversion,
    onSuccess: (result) => navigate(`/jobs/${result.jobId}`),
  });

  return (
    <form
      className={compact ? "conversion-form compact" : "conversion-form"}
      onSubmit={form.handleSubmit((values: FormValues) =>
        mutation.mutate({
          ...values,
          callbackUrl: values.callbackUrl || undefined,
        }),
      )}
    >
      <div className="form-grid">
        <Field
          id="url"
          label="Source URL"
          placeholder="https://example.com/input.mp4"
          {...form.register("url")}
          error={form.formState.errors.url?.message}
        />
        <label className="ec-field" htmlFor="format">
          <span>Output format</span>
          <select id="format" {...form.register("format")}>
            {formats.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="ec-field" htmlFor="quality">
          <span>Quality</span>
          <select id="quality" {...form.register("quality")}>
            {availableQualities.map((quality) => (
              <option key={quality} value={quality}>
                {quality === "audio" ? "Audio only" : quality}
              </option>
            ))}
          </select>
        </label>
        <Field
          id="callbackUrl"
          label="Callback URL"
          placeholder="https://client.example.com/webhooks/eliteconverter"
          {...form.register("callbackUrl")}
          error={form.formState.errors.callbackUrl?.message}
          hint="Optional for API users"
        />
      </div>
      <label className="permission-check">
        <input type="checkbox" {...form.register("permissionConfirmed")} />
        <span>Only convert media that you own or have permission to process.</span>
      </label>
      {form.formState.errors.permissionConfirmed ? (
        <p className="field-error" role="alert">
          {form.formState.errors.permissionConfirmed.message}
        </p>
      ) : null}
      <div className="turnstile-placeholder" aria-live="polite">
        <ShieldCheck aria-hidden="true" />
        <span>Turnstile verification is enforced by the API for anonymous conversions.</span>
      </div>
      {mutation.isError ? (
        <p className="form-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          {mutation.error.message}
        </p>
      ) : null}
      <Button loading={mutation.isPending} type="submit">
        Start conversion
        <ArrowRight aria-hidden="true" className="icon" />
      </Button>
    </form>
  );
};
