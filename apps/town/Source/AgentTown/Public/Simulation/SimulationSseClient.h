#pragma once

#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"
#include "Simulation/SimTypes.h"

DECLARE_MULTICAST_DELEGATE_OneParam(FOnSimulationSseEvent, const FSimSseEvent&);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnSimulationStreamStatusChanged, const FString& /*Status*/, const FString& /*Detail*/);

/** SSE client for GET /v1/simulation/runs/{id}/stream (Phase 1). */
class AGENTTOWN_API FSimulationSseClient
{
public:
	void Configure(const FString& InApiBase, const FString& InAccessToken, const FString& InRunId);

	void Connect();
	void Disconnect();

	bool IsConnected() const { return bConnected; }
	FString GetStreamStatus() const { return StreamStatus; }

	FOnSimulationSseEvent OnEvent;
	FOnSimulationStreamStatusChanged OnStreamStatusChanged;

private:
	void SetStreamStatus(const FString& Status, const FString& Detail = FString());
	void HandleRequestProgress(FHttpRequestPtr Request, uint64 BytesSent, uint64 BytesReceived);
	void HandleRequestComplete(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully);
	void AppendAndParseBuffer(const FString& Chunk);
	void ParseSseFrames();

	FString ApiBase;
	FString AccessToken;
	FString RunId;
	FString StreamStatus = TEXT("idle");
	FString ReceiveBuffer;
	bool bConnected = false;
	int32 LastReceivedBytes = 0;

	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> ActiveRequest;
};
