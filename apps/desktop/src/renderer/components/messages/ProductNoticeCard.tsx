import {
  noticeSeverityTone,
  openNoticeCta,
} from "@/components/layout/ProductNoticeBanner";
import { Button } from "@/components/ui";
import { statusChip, textLinkPrimary } from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { formatMessageTimeOfDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChatMessageDetail } from "@/services/messaging";
import { useNavigate } from "react-router-dom";
import {
  type ProductNoticePayload,
  SEVERITY_LABEL,
  optionalString,
  productNoticeDetailPath,
  resolveCardTemplate,
  serviceBodyNeedsDetail,
  splitNoticeContent,
} from "./productNotice";

/** Severity strip used when there is no cover (service always; article without cover). */
function SeverityTopBar({
  severity,
  time,
  createdAt,
}: {
  severity: string;
  time: string | null;
  createdAt: string;
}) {
  const tone = noticeSeverityTone(severity);
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs",
        statusChip[tone],
      )}
    >
      <span className="font-medium">
        {SEVERITY_LABEL[severity] ?? severity}
      </span>
      {time ? (
        <SimpleTooltip label={new Date(createdAt).toLocaleString()}>
          <span className="cursor-default tabular-nums opacity-90">{time}</span>
        </SimpleTooltip>
      ) : null}
    </div>
  );
}

function NoticeCta({
  label,
  url,
}: {
  label: string;
  url: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      variant="primary"
      size="sm"
      onClick={() => openNoticeCta(url, navigate)}
    >
      {label}
    </Button>
  );
}

function ServiceNoticeCard({
  message,
  payload,
  title,
  body,
  severity,
  time,
}: {
  message: ChatMessageDetail;
  payload: ProductNoticePayload;
  title: string;
  body: string;
  severity: string;
  time: string | null;
}) {
  const navigate = useNavigate();
  const ctaLabel = optionalString(payload.cta_label);
  const ctaUrl = optionalString(payload.cta_url);
  const noticeId = optionalString(payload.notice_id);
  const offerDetail = Boolean(noticeId && serviceBodyNeedsDetail(body));

  return (
    <div className="group flex justify-center py-1">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card">
        <SeverityTopBar
          severity={severity}
          time={time}
          createdAt={message.created_at}
        />
        <div className="px-3 py-3">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {body ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
              {body}
            </p>
          ) : null}
          {(ctaLabel && ctaUrl) || offerDetail ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {ctaLabel && ctaUrl ? (
                <NoticeCta label={ctaLabel} url={ctaUrl} />
              ) : null}
              {offerDetail && noticeId ? (
                <button
                  type="button"
                  className={textLinkPrimary}
                  onClick={() =>
                    navigate(productNoticeDetailPath(message.chat_id, noticeId))
                  }
                >
                  完整说明
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ArticleNoticeCard({
  message,
  payload,
  title,
  severity,
  time,
}: {
  message: ChatMessageDetail;
  payload: ProductNoticePayload;
  title: string;
  severity: string;
  time: string | null;
}) {
  const navigate = useNavigate();
  const coverUrl = optionalString(payload.cover_url);
  const summary = optionalString(payload.summary);
  const noticeId = optionalString(payload.notice_id);

  return (
    <div className="group flex justify-center py-1">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            className="aspect-[2/1] w-full object-cover"
          />
        ) : (
          <SeverityTopBar
            severity={severity}
            time={time}
            createdAt={message.created_at}
          />
        )}
        <div className="px-3 py-3">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {summary ? (
            <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">
              {summary}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {noticeId ? (
              <button
                type="button"
                className={textLinkPrimary}
                onClick={() =>
                  navigate(productNoticeDetailPath(message.chat_id, noticeId))
                }
              >
                阅读全文
              </button>
            ) : (
              <span />
            )}
            {coverUrl && time ? (
              <SimpleTooltip
                label={new Date(message.created_at).toLocaleString()}
              >
                <span className="cursor-default text-xs text-muted-foreground tabular-nums">
                  {time}
                </span>
              </SimpleTooltip>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Centered product-notice card: `service` (default / legacy) or `article`.
 */
export function ProductNoticeCard({
  message,
  payload,
}: {
  message: ChatMessageDetail;
  payload: ProductNoticePayload;
}) {
  const { title, body } = splitNoticeContent(message.content);
  const severity =
    typeof payload.severity === "string" && payload.severity
      ? payload.severity
      : "normal";
  const time = formatMessageTimeOfDay(message.created_at);
  const template = resolveCardTemplate(payload);

  if (template === "article") {
    return (
      <ArticleNoticeCard
        message={message}
        payload={payload}
        title={title}
        severity={severity}
        time={time}
      />
    );
  }

  return (
    <ServiceNoticeCard
      message={message}
      payload={payload}
      title={title}
      body={body}
      severity={severity}
      time={time}
    />
  );
}
