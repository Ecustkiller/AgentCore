using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Networking;

namespace AgentTown.Simulation
{
    /// <summary>
    /// HTTP client for the <c>/v1/simulation</c> REST surface (§5, P0–P1). Uses
    /// <see cref="UnityWebRequest"/> so the same code path works on Editor, desktop
    /// standalone and WebGL. Bearer auth per §8.1.
    ///
    /// <para>All methods must be invoked on the Unity main thread (they create a
    /// <see cref="UnityWebRequest"/>); awaited continuations resume on the main thread.</para>
    /// </summary>
    public sealed class SimulationRestClient
    {
        private const string SimBase = "/v1/simulation";

        private string apiBase = "";
        private string accessToken = "";

        public string LastError { get; private set; } = "";

        public void Configure(string apiBaseUrl, string token)
        {
            apiBase = TrimTrailingSlashes(apiBaseUrl ?? "");
            accessToken = token ?? "";
        }

        // ---- P0 ----

        /// <summary>POST <c>/runs</c> — create a run (§5 P0).</summary>
        public Task<SimulationRunSummary> CreateRunAsync(
            string scenario = "town", int? seed = null, CancellationToken ct = default)
        {
            var body = new JObject { ["scenario"] = scenario ?? "town" };
            if (seed.HasValue)
            {
                body["seed"] = seed.Value;
            }

            return SendJsonAsync<SimulationRunSummary>("POST", $"{SimBase}/runs", body.ToString(), ct);
        }

        /// <summary>POST <c>/runs/{id}/tick</c> — advance one tick (§5 P0).</summary>
        public Task<AdvanceTickResponse> AdvanceTickAsync(string runId, CancellationToken ct = default)
        {
            return SendJsonAsync<AdvanceTickResponse>("POST", RunPath(runId, "/tick"), "{}", ct);
        }

        /// <summary>GET <c>/runs/{id}/ticks/{n}</c> — persisted replay frame (§5 P0).</summary>
        public Task<SimTickFrameResponse> GetTickSnapshotAsync(
            string runId, int tickNumber, CancellationToken ct = default)
        {
            return SendJsonAsync<SimTickFrameResponse>("GET", RunPath(runId, $"/ticks/{tickNumber}"), null, ct);
        }

        // ---- P1 ----

        /// <summary>GET <c>/runs/{id}/manifest</c> — authoritative roster (§5 P1, §6.4).</summary>
        public Task<SimulationRunManifestResponse> GetManifestAsync(string runId, CancellationToken ct = default)
        {
            return SendJsonAsync<SimulationRunManifestResponse>("GET", RunPath(runId, "/manifest"), null, ct);
        }

        /// <summary>POST <c>/runs/{id}/pause</c> (§5 P1).</summary>
        public Task<SimulationRunStatusResponse> PauseRunAsync(string runId, CancellationToken ct = default)
        {
            return SendJsonAsync<SimulationRunStatusResponse>("POST", RunPath(runId, "/pause"), "{}", ct);
        }

        /// <summary>POST <c>/runs/{id}/resume</c> (§5 P1).</summary>
        public Task<SimulationRunStatusResponse> ResumeRunAsync(string runId, CancellationToken ct = default)
        {
            return SendJsonAsync<SimulationRunStatusResponse>("POST", RunPath(runId, "/resume"), "{}", ct);
        }

        // ---- internals ----

        private static string RunPath(string runId, string suffix) =>
            $"{SimBase}/runs/{Uri.EscapeDataString(runId ?? "")}{suffix}";

        private async Task<T> SendJsonAsync<T>(string method, string path, string body, CancellationToken ct)
            where T : class
        {
            if (string.IsNullOrEmpty(apiBase))
            {
                SetError($"{method} {path}: API base not configured");
                return null;
            }

            string url = apiBase + path;
            using var request = new UnityWebRequest(url, method)
            {
                downloadHandler = new DownloadHandlerBuffer(),
            };

            if (body != null)
            {
                request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                request.SetRequestHeader("Content-Type", "application/json");
            }

            request.SetRequestHeader("Accept", "application/json");
            if (!string.IsNullOrEmpty(accessToken))
            {
                request.SetRequestHeader("Authorization", $"Bearer {accessToken}");
            }

            await request.SendAsync(ct);

            if (ct.IsCancellationRequested)
            {
                SetError($"{method} {path}: cancelled");
                return null;
            }

            if (request.result != UnityWebRequest.Result.Success)
            {
                string detail = request.downloadHandler != null ? request.downloadHandler.text : "";
                SetError($"{method} {path} → HTTP {request.responseCode} {request.error} {detail}".Trim());
                return null;
            }

            if (!SimJson.TryDeserialize<T>(request.downloadHandler.text, out T parsed))
            {
                SetError($"{method} {path}: failed to parse response");
                return null;
            }

            return parsed;
        }

        private void SetError(string message)
        {
            LastError = message;
            Debug.LogWarning($"[AgentTown] SimulationRestClient: {message}");
        }

        private static string TrimTrailingSlashes(string value)
        {
            string result = value;
            while (result.EndsWith("/", StringComparison.Ordinal))
            {
                result = result.Substring(0, result.Length - 1);
            }

            return result;
        }
    }
}
