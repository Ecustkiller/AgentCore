#include "Misc/AutomationTest.h"
#include "Simulation/SimTypes.h"
#include "Simulation/SimulationSession.h"
#include "Simulation/WireCoordinateTransform.h"
#include "Town/TownNpcCharacter.h"
#include "Town/TownNpcManager.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS

#if WITH_EDITOR
#include "Editor.h"
#endif

// Honest, nav-free regression for the snapshot -> UE placement pipeline under the
// ×100 world scale. It verifies that a tick snapshot placing an agent at 市场
// (wire (24,0,0)) drives the NPC manager to spawn a character at the scaled UE feet
// location (2400,0,·). Real NavMesh walking is a runtime/PIE concern (an editor
// automation world does not tick/generate navmesh cleanly) and is validated by
// manual PIE Play or a future PIE functional test — not here.
namespace TownNpcPlacementTest
{
	static bool LoadMarketWirePosition(FWireVec3& OutWire)
	{
		const FString FixturePath = FPaths::Combine(
			FPaths::ProjectContentDir(),
			TEXT("Fixtures/simulation-region-positions.json"));

		FString JsonText;
		if (!FFileHelper::LoadFileToString(JsonText, *FixturePath))
		{
			return false;
		}

		TSharedPtr<FJsonObject> Root;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
		if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
		{
			return false;
		}

		const TSharedPtr<FJsonObject>* RegionsObj = nullptr;
		if (!Root->TryGetObjectField(TEXT("regions"), RegionsObj) || !RegionsObj->IsValid())
		{
			return false;
		}

		const TSharedPtr<FJsonObject>* MarketObj = nullptr;
		if (!(*RegionsObj)->TryGetObjectField(TEXT("市场"), MarketObj) || !MarketObj->IsValid())
		{
			return false;
		}

		double X = 0.0;
		double Y = 0.0;
		double Z = 0.0;
		(*MarketObj)->TryGetNumberField(TEXT("x"), X);
		(*MarketObj)->TryGetNumberField(TEXT("y"), Y);
		(*MarketObj)->TryGetNumberField(TEXT("z"), Z);
		OutWire = FWireVec3(X, Y, Z);
		return true;
	}

	static ATownNpcCharacter* FindFirstNpc(UWorld* World)
	{
		for (TActorIterator<ATownNpcCharacter> It(World); It; ++It)
		{
			return *It;
		}
		return nullptr;
	}
} // namespace TownNpcPlacementTest

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FAgentTownNpcSnapshotPlacementTest,
	"AgentTown.Simulation.Npc.SnapshotPlacesAtMarket",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FAgentTownNpcSnapshotPlacementTest::RunTest(const FString& Parameters)
{
	using namespace TownNpcPlacementTest;

#if WITH_EDITOR
	UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
#else
	UWorld* World = nullptr;
#endif
	if (!TestNotNull(TEXT("editor world available"), World))
	{
		return false;
	}

	FWireVec3 MarketWire;
	if (!TestTrue(TEXT("fixture has 市场 region"), LoadMarketWirePosition(MarketWire)))
	{
		return false;
	}
	// Wire fixtures stay in unscaled wire units — the ×100 lives only in ToUnreal.
	TestEqual(TEXT("市场 wire X is 24 (unscaled contract)"), MarketWire.X, 24.0);

	FSimulationSession& Session = FSimulationSession::Get();
	Session.Reset();

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	ATownNpcManager* Manager = World->SpawnActor<ATownNpcManager>(
		ATownNpcManager::StaticClass(),
		FVector::ZeroVector,
		FRotator::ZeroRotator,
		Params);
	if (!TestNotNull(TEXT("NPC manager spawned"), Manager))
	{
		Session.Reset();
		return false;
	}

	FSimTickSnapshot Snapshot;
	Snapshot.Tick = 0;
	Snapshot.Hour = 9;
	FSimAgentState Agent;
	Agent.AgentId = TEXT("agent-m1");
	Agent.Position = MarketWire;
	Snapshot.Agents.Add(Agent.AgentId, Agent);
	Session.ApplySnapshot(Snapshot);

	Manager->RefreshFromSession();

	ATownNpcCharacter* Npc = FindFirstNpc(World);
	if (TestNotNull(TEXT("NPC spawned from snapshot"), Npc))
	{
		const FVector Expected = ATownNpcCharacter::FeetLocationFromWire(
			FWireCoordinateTransform::ToUnreal(MarketWire));
		const FVector Actual = Npc->GetActorLocation();

		// ×100 world scale: wire (24,0,0) -> UE (2400,0,0); feet sit +GetSpawnZOffset() up.
		TestEqual(TEXT("NPC X at scaled 市场 (2400)"), Actual.X, Expected.X, 1.0);
		TestEqual(TEXT("NPC Y at scaled 市场 (0)"), Actual.Y, Expected.Y, 1.0);
		TestTrue(
			TEXT("NPC XY placed at 市场 feet location"),
			FVector::Dist2D(Actual, Expected) <= 2.0);

		Npc->Destroy();
	}

	Manager->Destroy();
	Session.Reset();
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
