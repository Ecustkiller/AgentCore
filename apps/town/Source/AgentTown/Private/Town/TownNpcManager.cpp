#include "Town/TownNpcManager.h"
#include "Town/TownNpcAIController.h"
#include "Town/TownNpcCharacter.h"
#include "Simulation/SimulationSession.h"

namespace
{
	static const int32 MaxNpcColors = 12;

	FLinearColor ColorForAgentIndex(int32 Index)
	{
		static const FLinearColor Palette[MaxNpcColors] = {
			FLinearColor(0.90f, 0.35f, 0.35f),
			FLinearColor(0.35f, 0.65f, 0.95f),
			FLinearColor(0.40f, 0.85f, 0.45f),
			FLinearColor(0.95f, 0.75f, 0.25f),
			FLinearColor(0.75f, 0.45f, 0.90f),
			FLinearColor(0.35f, 0.90f, 0.90f),
			FLinearColor(0.95f, 0.55f, 0.35f),
			FLinearColor(0.55f, 0.55f, 0.95f),
			FLinearColor(0.85f, 0.45f, 0.55f),
			FLinearColor(0.45f, 0.80f, 0.70f),
			FLinearColor(0.80f, 0.80f, 0.35f),
			FLinearColor(0.60f, 0.40f, 0.30f),
		};

		return Palette[FMath::Abs(Index) % MaxNpcColors];
	}

	ATownNpcAIController* GetNpcController(ACharacter* Npc)
	{
		return Npc ? Cast<ATownNpcAIController>(Npc->GetController()) : nullptr;
	}
}

ATownNpcManager::ATownNpcManager()
{
	PrimaryActorTick.bCanEverTick = false;
}

void ATownNpcManager::BeginPlay()
{
	Super::BeginPlay();

	FSimulationSession& Session = FSimulationSession::Get();
	SnapshotHandle = Session.OnSnapshotApplied.AddUObject(this, &ATownNpcManager::HandleSnapshotApplied);
	SyncNpcs();
}

void ATownNpcManager::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	FSimulationSession& Session = FSimulationSession::Get();
	Session.OnSnapshotApplied.Remove(SnapshotHandle);
	Super::EndPlay(EndPlayReason);
}

void ATownNpcManager::RefreshFromSession()
{
	SyncNpcs();
}

void ATownNpcManager::HandleSnapshotApplied()
{
	SyncNpcs();
}

void ATownNpcManager::ApplyNpcColor(ACharacter* Npc, const FString& AgentId)
{
	if (!Npc)
	{
		return;
	}

	const int32 ColorIndex = AgentColorIndices.FindRef(AgentId);
	const FLinearColor Color = ColorForAgentIndex(ColorIndex);

	if (ATownNpcCharacter* TownNpc = Cast<ATownNpcCharacter>(Npc))
	{
		TownNpc->ApplyAgentTint(Color);
	}
}

void ATownNpcManager::ApplyNpcGoal(ACharacter* Npc, const FVector& Goal, bool bSnap)
{
	if (!Npc)
	{
		return;
	}

	ATownNpcAIController* Controller = GetNpcController(Npc);
	if (!Controller)
	{
		if (bSnap)
		{
			Npc->SetActorLocation(Goal);
		}
		return;
	}

	if (bSnap)
	{
		Controller->TeleportToGoal(Goal);
	}
	else
	{
		Controller->SetNavigationGoal(Goal);
	}
}

void ATownNpcManager::SyncNpcs()
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return;
	}

	const FSimulationSession& Session = FSimulationSession::Get();
	const TMap<FString, FVector>& Positions = Session.GetAgentUnrealPositions();
	const bool bSnap = !Session.IsLive();

	int32 NextColorIndex = AgentColorIndices.Num();
	TSet<FString> SeenIds;
	for (const TPair<FString, FVector>& Pair : Positions)
	{
		SeenIds.Add(Pair.Key);
		if (!AgentColorIndices.Contains(Pair.Key))
		{
			AgentColorIndices.Add(Pair.Key, NextColorIndex++);
		}

		const FVector SpawnLoc = ATownNpcCharacter::FeetLocationFromWire(Pair.Value);

		TObjectPtr<ACharacter>* Existing = NpcActors.Find(Pair.Key);
		if (Existing && IsValid(*Existing))
		{
			if (!(*Existing)->GetController())
			{
				(*Existing)->SpawnDefaultController();
			}
			ApplyNpcGoal(*Existing, SpawnLoc, bSnap);
			continue;
		}

		FActorSpawnParameters Params;
		Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AdjustIfPossibleButAlwaysSpawn;
		ACharacter* Npc = World->SpawnActor<ATownNpcCharacter>(
			ATownNpcCharacter::StaticClass(),
			SpawnLoc,
			FRotator::ZeroRotator,
			Params);
		if (Npc)
		{
			Npc->SetActorLabel(FString::Printf(TEXT("NPC_%s"), *Pair.Key));
			if (!Npc->GetController())
			{
				Npc->SpawnDefaultController();
			}
			ApplyNpcColor(Npc, Pair.Key);
			NpcActors.Add(Pair.Key, Npc);
			ApplyNpcGoal(Npc, SpawnLoc, true);
		}
	}

	TArray<FString> StaleIds;
	for (const TPair<FString, TObjectPtr<ACharacter>>& Entry : NpcActors)
	{
		if (!SeenIds.Contains(Entry.Key))
		{
			StaleIds.Add(Entry.Key);
			if (IsValid(Entry.Value))
			{
				Entry.Value->Destroy();
			}
		}
	}

	for (const FString& StaleId : StaleIds)
	{
		NpcActors.Remove(StaleId);
		AgentColorIndices.Remove(StaleId);
	}
}
