#include "Town/TownGameMode.h"
#include "Config/AgentTownLaunchConfig.h"
#include "Simulation/SimulationSession.h"
#include "Town/TownBootstrap.h"
#include "Town/TownNpcManager.h"
#include "Town/TownObserverPawn.h"
#include "Town/TownPlayerController.h"

ATownGameMode::ATownGameMode()
{
	DefaultPawnClass = ATownObserverPawn::StaticClass();
	PlayerControllerClass = ATownPlayerController::StaticClass();
}

void ATownGameMode::StartPlay()
{
	const FAgentTownLaunchConfig Config = FAgentTownLaunchConfig::Load();
	FSimulationSession::Get().Configure(Config.ApiBase, Config.AccessToken, Config.RunId);

	BootstrapWorld();
	TryResumeRun();

	Super::StartPlay();
}

void ATownGameMode::BootstrapWorld()
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return;
	}

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	BootstrapActor = World->SpawnActor<ATownBootstrap>(ATownBootstrap::StaticClass(), FVector::ZeroVector, FRotator::ZeroRotator, Params);
	NpcManager = World->SpawnActor<ATownNpcManager>(ATownNpcManager::StaticClass(), FVector::ZeroVector, FRotator::ZeroRotator, Params);
}

void ATownGameMode::TryResumeRun()
{
	const FSimulationSession& Session = FSimulationSession::Get();
	if (Session.GetRunId().IsEmpty())
	{
		return;
	}

	FSimulationSession::Get().BootstrapActiveRun();
	FSimulationSession::Get().FetchLiveTickAsync(1, nullptr);
}
