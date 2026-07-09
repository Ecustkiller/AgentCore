using UnrealBuildTool;
using System.Collections.Generic;

public class AgentTownEditorTarget : TargetRules
{
	public AgentTownEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
		ExtraModuleNames.Add("AgentTown");
	}
}
