export function AboutSettings() {
  return (
    <div>
      <h1 className="text-xl font-semibold">关于 AgentCore</h1>
      <p className="mt-2 text-sm text-muted-foreground">版本信息与更新检查。</p>
      <div className="mt-6 space-y-2 text-sm">
        <p>
          <span className="text-muted-foreground">版本：</span>
          <span>0.1.0</span>
        </p>
      </div>
    </div>
  );
}
