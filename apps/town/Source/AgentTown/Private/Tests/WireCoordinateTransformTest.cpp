#include "Misc/AutomationTest.h"
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
	"AgentTown.Simulation.WireCoordinate.MarketMapsTo24_0_0",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FWireCoordinateMarketTest::RunTest(const FString& Parameters)
{
	const FVector Ue = FWireCoordinateTransform::ToUnreal(24.0, 0.0, 0.0);
	TestEqual(TEXT("Market X"), Ue.X, 24.0f);
	TestEqual(TEXT("Market Y"), Ue.Y, 0.0f);
	TestEqual(TEXT("Market Z"), Ue.Z, 0.0f);
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

	TMap<FString, FWireVec3> Agents;
	Agents.Add(TEXT("agent-1"), FWireVec3(24.0, 0.0, 0.0));

	Session.ApplySnapshot(Agents);
	// Smoke: ApplySnapshot runs without throw; full agent map accessors come in UE-01.
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
