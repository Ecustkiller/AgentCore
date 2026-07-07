using UnrealBuildTool;

public class AgentTown : ModuleRules
{
	public AgentTown(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(
			new string[]
			{
				"Core",
				"CoreUObject",
				"Engine",
				"HTTP",
				"Json",
				"JsonUtilities",
				"AIModule",
				"NavigationSystem",
			});

		if (Target.bBuildDeveloperTools)
		{
			PrivateDependencyModuleNames.Add("AutomationController");
		}
	}
}
