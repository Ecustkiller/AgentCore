#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "TownGameMode.generated.h"

UCLASS()
class AGENTTOWN_API ATownGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	ATownGameMode();

	virtual void StartPlay() override;

private:
	void BootstrapWorld();
	void TryResumeRun();

	UPROPERTY()
	TObjectPtr<class ATownBootstrap> BootstrapActor;

	UPROPERTY()
	TObjectPtr<class ATownNpcManager> NpcManager;
};
