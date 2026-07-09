using UnrealBuildTool;
using System.Collections.Generic;

public class AgentTownTarget : TargetRules
{
	public AgentTownTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
		ExtraModuleNames.Add("AgentTown");
	}
}
