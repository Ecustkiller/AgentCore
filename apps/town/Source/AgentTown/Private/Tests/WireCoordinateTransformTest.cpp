#include "Misc/AutomationTest.h"
#include "Simulation/SimTypes.h"
#include "Simulation/SimulationSession.h"
#include "Simulation/WireCoordinateTransform.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS

static bool LoadRegionFixture(TSharedPtr<FJsonObject>& OutRoot)
{
	const FString FixturePath = FPaths::Combine(
		FPaths::ProjectContentDir(),
		TEXT("Fixtures/simulation-region-positions.json"));

	FString JsonText;
	if (!FFileHelper::LoadFileToString(JsonText, *FixturePath))
	{
		return false;
	}

	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	return FJsonSerializer::Deserialize(Reader, OutRoot) && OutRoot.IsValid();
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FWireCoordinateMarketTest,
	"AgentTown.Simulation.WireCoordinate.MarketMapsTo2400_0_0",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FWireCoordinateMarketTest::RunTest(const FString& Parameters)
{
	const FVector Ue = FWireCoordinateTransform::ToUnreal(24.0, 0.0, 0.0);
	TestEqual(TEXT("Market X"), Ue.X, 2400.0);
	TestEqual(TEXT("Market Y"), Ue.Y, 0.0);
	TestEqual(TEXT("Market Z"), Ue.Z, 0.0);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FWireCoordinateRegionFixtureTest,
	"AgentTown.Simulation.WireCoordinate.AllRegionsFromFixture",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FWireCoordinateRegionFixtureTest::RunTest(const FString& Parameters)
{
	TSharedPtr<FJsonObject> Root;
	if (!LoadRegionFixture(Root))
	{
		AddError(FString::Printf(TEXT("Missing fixture: %sFixtures/simulation-region-positions.json"),
			*FPaths::ProjectContentDir()));
		return false;
	}

	const TSharedPtr<FJsonObject>* RegionsObj = nullptr;
	if (!Root->TryGetObjectField(TEXT("regions"), RegionsObj) || !RegionsObj->IsValid())
	{
		AddError(TEXT("Fixture missing 'regions' object"));
		return false;
	}

	for (const TPair<FString, TSharedPtr<FJsonValue>>& RegionEntry : (*RegionsObj)->Values)
	{
		const TSharedPtr<FJsonObject>* PosObj = nullptr;
		if (!RegionEntry.Value->TryGetObject(PosObj) || !PosObj->IsValid())
		{
			AddError(FString::Printf(TEXT("Region %s: not an object"), *RegionEntry.Key));
			continue;
		}

		double X = 0.0, Y = 0.0, Z = 0.0;
		(*PosObj)->TryGetNumberField(TEXT("x"), X);
		(*PosObj)->TryGetNumberField(TEXT("y"), Y);
		(*PosObj)->TryGetNumberField(TEXT("z"), Z);

		const FWireVec3 Wire(X, Y, Z);
		TestTrue(*FString::Printf(TEXT("Region %s wire finite"), *RegionEntry.Key), Wire.IsFinite());

		const FVector Ue = FWireCoordinateTransform::ToUnreal(Wire);
		const bool bFinite = FMath::IsFinite(Ue.X) && FMath::IsFinite(Ue.Y) && FMath::IsFinite(Ue.Z);
		TestTrue(*FString::Printf(TEXT("Region %s ue finite"), *RegionEntry.Key), bFinite);
	}

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FSimulationSessionApplySnapshotTest,
	"AgentTown.Simulation.Session.ApplySnapshotTransformsAgents",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FSimulationSessionApplySnapshotTest::RunTest(const FString& Parameters)
{
	FSimulationSession& Session = FSimulationSession::Get();
	Session.Reset();

	FSimTickSnapshot Snapshot;
	Snapshot.Tick = 1;
	Snapshot.Hour = 9;
	FSimAgentState Agent;
	Agent.AgentId = TEXT("agent-1");
	Agent.Position = FWireVec3(24.0, 0.0, 0.0);
	Snapshot.Agents.Add(Agent.AgentId, Agent);

	Session.ApplySnapshot(Snapshot);

	const TMap<FString, FVector>& Positions = Session.GetAgentUnrealPositions();
	const FVector* UePos = Positions.Find(TEXT("agent-1"));
	TestNotNull(TEXT("agent-1 position"), UePos);
	if (UePos)
	{
		TestEqual(TEXT("agent-1 X"), UePos->X, 2400.0);
	}
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
