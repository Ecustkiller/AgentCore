#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "TownNpcManager.generated.h"

class ACharacter;

/** Spawns and updates NPC characters from SimulationSession snapshots. */
UCLASS()
class AGENTTOWN_API ATownNpcManager : public AActor
{
	GENERATED_BODY()

public:
	ATownNpcManager();

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

	/** Re-read SimulationSession positions (used by automation). */
	void RefreshFromSession();

private:
	void HandleSnapshotApplied();
	void SyncNpcs();
	void ApplyNpcColor(ACharacter* Npc, const FString& AgentId);
	void ApplyNpcGoal(ACharacter* Npc, const FVector& Goal, bool bSnap);

	UPROPERTY()
	TMap<FString, TObjectPtr<ACharacter>> NpcActors;

	TMap<FString, int32> AgentColorIndices;

	FDelegateHandle SnapshotHandle;
};
