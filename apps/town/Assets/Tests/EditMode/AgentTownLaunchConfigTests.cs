using System.Collections.Generic;
using AgentTown.Town;
using NUnit.Framework;

namespace AgentTown.Tests
{
    /// <summary>EditMode coverage for launch-arg / URL-query parsing (§8.1).</summary>
    public sealed class AgentTownLaunchConfigTests
    {
        [Test]
        public void ParseCommandLine_HandlesSpaceAndEqualsForms()
        {
            string[] argv =
            {
                "AgentTown.exe", "--api", "http://localhost:9000", "--token=abc.def", "--run-id", "run-123",
            };

            Dictionary<string, string> args = AgentTownLaunchConfig.ParseCommandLine(argv);

            Assert.AreEqual("http://localhost:9000", args["api"]);
            Assert.AreEqual("abc.def", args["token"]);
            Assert.AreEqual("run-123", args["run-id"]);
        }

        [Test]
        public void ParseQuery_DecodesEscapedValues()
        {
            Dictionary<string, string> query =
                AgentTownLaunchConfig.ParseQuery("https://town.example/app?api=http%3A%2F%2Fh%3A8000&token=t1&run=r9#frag");

            Assert.AreEqual("http://h:8000", query["api"], "url-encoded api decoded");
            Assert.AreEqual("t1", query["token"]);
            Assert.AreEqual("r9", query["run"], "fragment stripped");
        }

        [Test]
        public void ParseCommandLine_NullSafe()
        {
            Assert.IsEmpty(AgentTownLaunchConfig.ParseCommandLine(null));
        }
    }
}
