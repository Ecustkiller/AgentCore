using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace AgentTown.Town
{
    /// <summary>
    /// Resolves the API base / access token / run id at launch (§8). Precedence, low → high:
    /// built-in default → desktop <c>session.json</c> (§8.2) → desktop CLI args (§8.1) →
    /// WebGL URL query (<c>?api=&amp;token=&amp;run=</c>, §8.1). CLI / URL win so a launcher can
    /// always override the persisted session.
    /// </summary>
    public readonly struct AgentTownLaunchConfig
    {
        public const string DefaultApiBase = "http://localhost:8000";

        public readonly string ApiBase;
        public readonly string AccessToken;
        public readonly string RunId;

        public AgentTownLaunchConfig(string apiBase, string accessToken, string runId)
        {
            ApiBase = apiBase;
            AccessToken = accessToken;
            RunId = runId;
        }

        public static AgentTownLaunchConfig Load()
        {
            string apiBase = DefaultApiBase;
            string token = "";
            string runId = "";

            ApplySessionJson(ref apiBase, ref token);
            ApplyCommandLine(ref apiBase, ref token, ref runId);
            ApplyUrlQuery(ref apiBase, ref token, ref runId);

            return new AgentTownLaunchConfig(apiBase, token, runId);
        }

        private static void ApplyCommandLine(ref string apiBase, ref string token, ref string runId)
        {
#if !UNITY_WEBGL || UNITY_EDITOR
            Dictionary<string, string> args = ParseCommandLine(Environment.GetCommandLineArgs());
            if (args.TryGetValue("api", out string api) && !string.IsNullOrEmpty(api))
            {
                apiBase = api;
            }

            if (args.TryGetValue("token", out string t) && !string.IsNullOrEmpty(t))
            {
                token = t;
            }

            if (args.TryGetValue("run-id", out string run) && !string.IsNullOrEmpty(run))
            {
                runId = run;
            }
            else if (args.TryGetValue("run", out string run2) && !string.IsNullOrEmpty(run2))
            {
                runId = run2;
            }
#endif
        }

        private static void ApplyUrlQuery(ref string apiBase, ref string token, ref string runId)
        {
            string url = Application.absoluteURL;
            if (string.IsNullOrEmpty(url) || !url.Contains("?"))
            {
                return;
            }

            Dictionary<string, string> query = ParseQuery(url);
            if (query.TryGetValue("api", out string api) && !string.IsNullOrEmpty(api))
            {
                apiBase = api;
            }

            if (query.TryGetValue("token", out string t) && !string.IsNullOrEmpty(t))
            {
                token = t;
            }

            if (query.TryGetValue("run", out string run) && !string.IsNullOrEmpty(run))
            {
                runId = run;
            }
            else if (query.TryGetValue("run-id", out string run2) && !string.IsNullOrEmpty(run2))
            {
                runId = run2;
            }
        }

        private static void ApplySessionJson(ref string apiBase, ref string token)
        {
#if !UNITY_WEBGL || UNITY_EDITOR
            string path = SessionJsonPath();
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                return;
            }

            try
            {
                JObject root = JObject.Parse(File.ReadAllText(path));
                string api = root.Value<string>("api_base");
                if (!string.IsNullOrEmpty(api))
                {
                    apiBase = api;
                }

                string t = root.Value<string>("access_token");
                if (!string.IsNullOrEmpty(t))
                {
                    token = t;
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[AgentTown] Failed to read session.json: {e.Message}");
            }
#endif
        }

        private static string SessionJsonPath()
        {
            // Windows: %APPDATA%/AgentCore ; macOS: ~/Library/Application Support/AgentCore ; else ~/.config/AgentCore
            if (Application.platform == RuntimePlatform.WindowsPlayer ||
                Application.platform == RuntimePlatform.WindowsEditor)
            {
                string appData = Environment.GetEnvironmentVariable("APPDATA");
                return string.IsNullOrEmpty(appData) ? null : Path.Combine(appData, "AgentCore", "session.json");
            }

            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (string.IsNullOrEmpty(home))
            {
                return null;
            }

            if (Application.platform == RuntimePlatform.OSXPlayer ||
                Application.platform == RuntimePlatform.OSXEditor)
            {
                return Path.Combine(home, "Library", "Application Support", "AgentCore", "session.json");
            }

            return Path.Combine(home, ".config", "AgentCore", "session.json");
        }

        /// <summary>Parse <c>--key value</c>, <c>--key=value</c>, <c>-key value</c> pairs. Exposed for tests.</summary>
        public static Dictionary<string, string> ParseCommandLine(string[] argv)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (argv == null)
            {
                return result;
            }

            for (int i = 0; i < argv.Length; i++)
            {
                string arg = argv[i];
                if (string.IsNullOrEmpty(arg) || arg[0] != '-')
                {
                    continue;
                }

                string key = arg.TrimStart('-');
                int eq = key.IndexOf('=');
                if (eq >= 0)
                {
                    result[key.Substring(0, eq)] = key.Substring(eq + 1);
                    continue;
                }

                if (i + 1 < argv.Length && (argv[i + 1].Length == 0 || argv[i + 1][0] != '-'))
                {
                    result[key] = argv[++i];
                }
                else
                {
                    result[key] = "true";
                }
            }

            return result;
        }

        /// <summary>Parse a URL query string into decoded key/value pairs. Exposed for tests.</summary>
        public static Dictionary<string, string> ParseQuery(string url)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(url))
            {
                return result;
            }

            int q = url.IndexOf('?');
            string query = q >= 0 ? url.Substring(q + 1) : url;
            int hash = query.IndexOf('#');
            if (hash >= 0)
            {
                query = query.Substring(0, hash);
            }

            foreach (string pair in query.Split('&'))
            {
                if (string.IsNullOrEmpty(pair))
                {
                    continue;
                }

                int eq = pair.IndexOf('=');
                if (eq < 0)
                {
                    result[Uri.UnescapeDataString(pair)] = "";
                    continue;
                }

                string key = Uri.UnescapeDataString(pair.Substring(0, eq));
                string value = Uri.UnescapeDataString(pair.Substring(eq + 1));
                result[key] = value;
            }

            return result;
        }
    }
}
